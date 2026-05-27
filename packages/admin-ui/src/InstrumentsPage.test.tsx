import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InstrumentsPage } from './InstrumentsPage.js';
import { api } from './api.js';
import type { Instrument } from './api.js';

// ─── Mock the API module ──────────────────────────────────────────────────────

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,  // keep VALID_ACTIONS etc.
    api: {
      getInstruments:  vi.fn(),
      addInstrument:   vi.fn(),
      delistInstrument: vi.fn(),
      setMarketState:  vi.fn(),
      setSchedule:     vi.fn(),
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inst(overrides?: Partial<Instrument>): Instrument {
  return {
    symbol: 'ESZ4', name: 'E-mini S&P Dec 2024',
    tickSize: 0.25, contractSize: 50, currency: 'USD',
    expiryDate: '2024-12-20', marketState: 'Closed',
    ...overrides,
  };
}

const mockApi = api as Record<keyof typeof api, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getInstruments.mockResolvedValue([]);
  mockApi.addInstrument.mockResolvedValue(inst());
  mockApi.delistInstrument.mockResolvedValue(undefined);
  mockApi.setMarketState.mockResolvedValue(inst({ marketState: 'Open' }));
  mockApi.setSchedule.mockResolvedValue({});
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InstrumentsPage', () => {
  it('renders the instrument table with fetched data', async () => {
    mockApi.getInstruments.mockResolvedValue([inst()]);
    render(<InstrumentsPage />);
    await screen.findByText('ESZ4');
    expect(screen.getByText('E-mini S&P Dec 2024')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('shows "Add Instrument" form and validates required fields', async () => {
    render(<InstrumentsPage />);
    await screen.findByRole('button', { name: /add instrument/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add instrument/i }));

    // Submit with empty form — validation should fire
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(screen.getByText(/symbol is required/i)).toBeInTheDocument();
  });

  it('successfully added instrument appears in the table', async () => {
    const newInst = inst({ symbol: 'NQZ4', name: 'Nasdaq Dec 2024' });
    mockApi.addInstrument.mockResolvedValue(newInst);
    // After add, getInstruments returns the new list
    mockApi.getInstruments
      .mockResolvedValueOnce([])
      .mockResolvedValue([newInst]);

    render(<InstrumentsPage />);
    await screen.findByRole('button', { name: /add instrument/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add instrument/i }));

    await user.type(screen.getByLabelText(/symbol/i),        'NQZ4');
    await user.type(screen.getByLabelText(/name/i),          'Nasdaq Dec 2024');
    await user.type(screen.getByLabelText(/tick size/i),     '0.25');
    await user.type(screen.getByLabelText(/contract size/i), '20');
    await user.type(screen.getByLabelText(/currency/i),      'USD');
    await user.type(screen.getByLabelText(/expiry date/i),   '2024-12-20');

    await user.click(screen.getByRole('button', { name: /submit/i }));

    await screen.findByText('NQZ4');
    expect(mockApi.addInstrument).toHaveBeenCalledOnce();
  });

  it('delist requires confirmation before calling the API', async () => {
    mockApi.getInstruments.mockResolvedValue([inst()]);
    render(<InstrumentsPage />);
    await screen.findByText('ESZ4');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /delist/i }));

    // Confirmation prompt should appear
    expect(screen.getByText(/confirm delist/i)).toBeInTheDocument();
    expect(mockApi.delistInstrument).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(mockApi.delistInstrument).toHaveBeenCalledWith('ESZ4'));
  });

  it('shows only valid actions for the current Market State', async () => {
    mockApi.getInstruments.mockResolvedValue([
      inst({ symbol: 'ESZ4', marketState: 'Closed' }),
      inst({ symbol: 'NQZ4', marketState: 'Open' }),
      inst({ symbol: 'GCZ4', marketState: 'Halted' }),
    ]);
    render(<InstrumentsPage />);
    await screen.findByText('ESZ4');

    const rows = screen.getAllByRole('row').slice(1); // skip header

    const closedRow  = rows.find(r => within(r).queryByText('ESZ4'))!;
    const openRow    = rows.find(r => within(r).queryByText('NQZ4'))!;
    const haltedRow  = rows.find(r => within(r).queryByText('GCZ4'))!;

    // Closed → only Open action
    expect(within(closedRow).getByRole('button', { name: /^open$/i })).toBeInTheDocument();
    expect(within(closedRow).queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();

    // Open → Close and Halt
    expect(within(openRow).getByRole('button',  { name: /^close$/i })).toBeInTheDocument();
    expect(within(openRow).getByRole('button',  { name: /^halt$/i  })).toBeInTheDocument();
    expect(within(openRow).queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument();

    // Halted → Resume and Close
    expect(within(haltedRow).getByRole('button',  { name: /^resume$/i })).toBeInTheDocument();
    expect(within(haltedRow).getByRole('button',  { name: /^close$/i  })).toBeInTheDocument();
    expect(within(haltedRow).queryByRole('button', { name: /^halt$/i  })).not.toBeInTheDocument();
  });

  it('state transition updates the Market State badge', async () => {
    mockApi.getInstruments.mockResolvedValue([inst({ marketState: 'Closed' })]);
    mockApi.setMarketState.mockResolvedValue(inst({ marketState: 'Open' }));
    render(<InstrumentsPage />);
    await screen.findByText('Closed');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^open$/i }));

    await screen.findByText('Open');
    expect(mockApi.setMarketState).toHaveBeenCalledWith('ESZ4', 'open');
  });

  it('Set Schedule saves open/close times', async () => {
    mockApi.getInstruments.mockResolvedValue([inst()]);
    render(<InstrumentsPage />);
    await screen.findByText('ESZ4');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /schedule/i }));

    await user.clear(screen.getByLabelText(/open time/i));
    await user.type(screen.getByLabelText(/open time/i),  '08:30');
    await user.clear(screen.getByLabelText(/close time/i));
    await user.type(screen.getByLabelText(/close time/i), '15:00');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(mockApi.setSchedule).toHaveBeenCalledWith('ESZ4', '08:30', '15:00'),
    );
  });

  it('surfaces API errors as readable messages', async () => {
    mockApi.getInstruments.mockResolvedValue([inst()]);
    mockApi.setMarketState.mockRejectedValue(new Error('Invalid state transition'));
    render(<InstrumentsPage />);
    await screen.findByText('Closed');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^open$/i }));

    await screen.findByText(/invalid state transition/i);
  });
});
