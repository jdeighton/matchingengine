import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SessionsPage } from './SessionsPage.js';
import { api } from './api.js';
import type { SessionInfo } from './api.js';

// ─── Mock the API module ──────────────────────────────────────────────────────

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSessions:   vi.fn(),
      addSession:    vi.fn(),
      removeSession: vi.fn(),
    },
  };
});

const mockApi = api as Record<keyof typeof api, ReturnType<typeof vi.fn>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function session(overrides?: Partial<SessionInfo>): SessionInfo {
  return { sessionId: 'EXCHANGE-CLIENT1-FIX.4.4', status: 'inactive', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSessions.mockResolvedValue([]);
  mockApi.addSession.mockResolvedValue(session());
  mockApi.removeSession.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionsPage', () => {
  it('renders the sessions table with fetched data', async () => {
    mockApi.getSessions.mockResolvedValue([session({ status: 'inactive' })]);
    render(<SessionsPage />);
    await screen.findByText('EXCHANGE-CLIENT1-FIX.4.4');
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('shows "Add Session" form and validates required fields', async () => {
    render(<SessionsPage />);
    await screen.findByRole('button', { name: /add session/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add session/i }));
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(screen.getByText(/sendercompid is required/i)).toBeInTheDocument();
  });

  it('successfully added session appears in the table with all columns', async () => {
    const newSession: SessionInfo = {
      sessionId: 'EXCHANGE-TRADER1-FIX.4.4',
      status:    'inactive',
    };
    mockApi.addSession.mockResolvedValue(newSession);
    mockApi.getSessions
      .mockResolvedValueOnce([])
      .mockResolvedValue([newSession]);

    render(<SessionsPage />);
    await screen.findByRole('button', { name: /add session/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add session/i }));

    await user.type(screen.getByLabelText(/sendercompid/i), 'EXCHANGE');
    await user.type(screen.getByLabelText(/targetcompid/i), 'TRADER1');
    await user.type(screen.getByLabelText(/port/i),         '9001');

    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Row should appear with senderCompId, targetCompId, port from the form
    await screen.findByText('EXCHANGE');
    expect(screen.getByText('TRADER1')).toBeInTheDocument();
    expect(screen.getByText('9001')).toBeInTheDocument();
    expect(mockApi.addSession).toHaveBeenCalledWith(
      expect.objectContaining({ senderCompId: 'EXCHANGE', targetCompId: 'TRADER1', port: 9001 }),
    );
  });

  it('remove requires confirmation before calling the API', async () => {
    mockApi.getSessions.mockResolvedValue([session()]);
    render(<SessionsPage />);
    await screen.findByText('EXCHANGE-CLIENT1-FIX.4.4');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /remove/i }));

    expect(screen.getByText(/confirm remove/i)).toBeInTheDocument();
    expect(mockApi.removeSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() =>
      expect(mockApi.removeSession).toHaveBeenCalledWith('EXCHANGE-CLIENT1-FIX.4.4'),
    );
  });

  it('removed session disappears from the table', async () => {
    mockApi.getSessions.mockResolvedValue([session()]);
    render(<SessionsPage />);
    await screen.findByText('EXCHANGE-CLIENT1-FIX.4.4');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /remove/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() =>
      expect(screen.queryByText('EXCHANGE-CLIENT1-FIX.4.4')).not.toBeInTheDocument(),
    );
  });

  it('shows Active badge when session status is active', async () => {
    mockApi.getSessions.mockResolvedValue([session({ status: 'active' })]);
    render(<SessionsPage />);
    await screen.findByText('Active');
  });

  it('surfaces API errors as readable messages', async () => {
    mockApi.getSessions.mockResolvedValue([session()]);
    mockApi.removeSession.mockRejectedValue(new Error('Session not found'));
    render(<SessionsPage />);
    await screen.findByText('EXCHANGE-CLIENT1-FIX.4.4');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /remove/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await screen.findByText(/session not found/i);
  });
});
