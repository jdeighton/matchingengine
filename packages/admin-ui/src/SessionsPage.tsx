import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api.js';
import type { SessionInfo, SessionDisplay, AddSessionRequest } from './api.js';

// ─── Status badge ─────────────────────────────────────────────────────────────

const BADGE_STYLE: Record<SessionInfo['status'], React.CSSProperties> = {
  active:   { background: '#22c55e', color: '#fff', borderRadius: 4, padding: '2px 8px' },
  inactive: { background: '#6b7280', color: '#fff', borderRadius: 4, padding: '2px 8px' },
};

function StatusBadge({ status }: { status: SessionInfo['status'] }) {
  const label = status === 'active' ? 'Active' : 'Inactive';
  return <span style={BADGE_STYLE[status]}>{label}</span>;
}

// ─── AddSessionForm ───────────────────────────────────────────────────────────

interface AddSessionFormProps {
  onSuccess: (session: SessionInfo, req: AddSessionRequest) => void;
  onCancel:  () => void;
}

function AddSessionForm({ onSuccess, onCancel }: AddSessionFormProps) {
  const [fields, setFields] = useState({ senderCompId: '', targetCompId: '', port: '' });
  const [errors, setErrors] = useState<Partial<typeof fields>>({});
  const [apiError, setApiError] = useState<string | null>(null);

  function validate() {
    const errs: Partial<typeof fields> = {};
    if (!fields.senderCompId.trim()) errs.senderCompId = 'SenderCompID is required';
    if (!fields.targetCompId.trim()) errs.targetCompId = 'TargetCompID is required';
    const port = Number(fields.port);
    if (!fields.port.trim() || !Number.isInteger(port) || port <= 0)
      errs.port = 'Port must be a positive integer';
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const req: AddSessionRequest = {
      senderCompId: fields.senderCompId.trim(),
      targetCompId: fields.targetCompId.trim(),
      port:         Number(fields.port),
    };
    try {
      const result = await api.addSession(req);
      onSuccess(result, req);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to add session');
    }
  }

  function field(key: keyof typeof fields, label: string, type = 'text') {
    return (
      <div>
        <label htmlFor={`add-sess-${key}`}>{label}</label>
        <input
          id={`add-sess-${key}`}
          type={type}
          value={fields[key]}
          onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
        />
        {errors[key] && <span role="alert">{errors[key]}</span>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      {field('senderCompId', 'SenderCompID')}
      {field('targetCompId', 'TargetCompID')}
      {field('port',         'Port', 'number')}
      {apiError && <p role="alert">{apiError}</p>}
      <button type="submit">Submit</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ─── SessionsPage ─────────────────────────────────────────────────────────────

interface RowState {
  confirmRemove: boolean;
  rowError:      string | null;
}

const defaultRow = (): RowState => ({ confirmRemove: false, rowError: null });

export function SessionsPage() {
  const [sessions,  setSessions]  = useState<SessionDisplay[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [showAdd,   setShowAdd]   = useState(false);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  // Metadata captured at add-time (senderCompId, targetCompId, port).
  // Kept in a ref so refresh() never needs it as a useCallback dep.
  const sessionMetaRef = useRef<Map<string, { senderCompId: string; targetCompId: string; port: number }>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const raw = await api.getSessions();
      setSessions(raw.map((s) => {
        const m = sessionMetaRef.current.get(s.sessionId);
        return m
          ? { ...s, ...m }
          : { ...s, senderCompId: s.sessionId, targetCompId: '', port: 0 };
      }));
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  function patchRow(sessionId: string, patch: Partial<RowState>) {
    setRowStates((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? defaultRow()), ...patch },
    }));
  }

  function handleAddSuccess(info: SessionInfo, req: AddSessionRequest) {
    setShowAdd(false);
    sessionMetaRef.current.set(info.sessionId, {
      senderCompId: req.senderCompId,
      targetCompId: req.targetCompId,
      port:         req.port,
    });
    setSessions((prev) => [
      ...prev,
      { ...info, senderCompId: req.senderCompId, targetCompId: req.targetCompId, port: req.port },
    ]);
    void refresh();
  }

  async function handleRemove(sessionId: string) {
    try {
      await api.removeSession(sessionId);
      sessionMetaRef.current.delete(sessionId);
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      setRowStates((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
    } catch (err) {
      patchRow(sessionId, { rowError: err instanceof Error ? err.message : 'Error', confirmRemove: false });
    }
  }

  return (
    <div>
      <h1>FIX Sessions</h1>
      {pageError && <p role="alert">{pageError}</p>}

      <button onClick={() => setShowAdd((v) => !v)}>Add Session</button>

      {showAdd && (
        <AddSessionForm
          onSuccess={handleAddSuccess}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <table>
        <thead>
          <tr>
            <th>SenderCompID</th>
            <th>TargetCompID</th>
            <th>Port</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((sess) => {
            const rs = rowStates[sess.sessionId] ?? defaultRow();
            return (
              <tr key={sess.sessionId}>
                <td>{sess.senderCompId}</td>
                <td>{sess.targetCompId}</td>
                <td>{sess.port || '—'}</td>
                <td><StatusBadge status={sess.status} /></td>
                <td>
                  {rs.rowError && <span role="alert">{rs.rowError}</span>}
                  {!rs.confirmRemove ? (
                    <button onClick={() => patchRow(sess.sessionId, { confirmRemove: true })}>
                      Remove
                    </button>
                  ) : (
                    <>
                      <span>Confirm remove {sess.sessionId}?</span>
                      <button onClick={() => void handleRemove(sess.sessionId)}>Confirm</button>
                      <button onClick={() => patchRow(sess.sessionId, { confirmRemove: false })}>Cancel</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
