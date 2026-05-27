import { useState, useEffect, useCallback } from 'react';
import { api, VALID_ACTIONS } from './api.js';
import type { Instrument, MarketState, StateAction } from './api.js';

// ─── MarketState badge ────────────────────────────────────────────────────────

const BADGE_STYLE: Record<MarketState, React.CSSProperties> = {
  Open:   { background: '#22c55e', color: '#fff', borderRadius: 4, padding: '2px 8px' },
  Closed: { background: '#6b7280', color: '#fff', borderRadius: 4, padding: '2px 8px' },
  Halted: { background: '#f59e0b', color: '#fff', borderRadius: 4, padding: '2px 8px' },
};

function MarketStateBadge({ state }: { state: MarketState }) {
  return <span style={BADGE_STYLE[state]}>{state}</span>;
}

// ─── AddInstrumentForm ────────────────────────────────────────────────────────

interface AddFormProps {
  onSuccess: (instrument: Instrument) => void;
  onCancel:  () => void;
}

function AddInstrumentForm({ onSuccess, onCancel }: AddFormProps) {
  const [fields, setFields] = useState({
    symbol: '', name: '', tickSize: '', contractSize: '', currency: '', expiryDate: '',
  });
  const [errors, setErrors] = useState<Partial<typeof fields>>({});
  const [apiError, setApiError] = useState<string | null>(null);

  function validate() {
    const errs: Partial<typeof fields> = {};
    if (!fields.symbol.trim())       errs.symbol       = 'Symbol is required';
    if (!fields.name.trim())         errs.name         = 'Name is required';
    if (!fields.tickSize.trim() || isNaN(Number(fields.tickSize)) || Number(fields.tickSize) <= 0)
      errs.tickSize = 'Tick size must be a positive number';
    if (!fields.contractSize.trim() || isNaN(Number(fields.contractSize)) || Number(fields.contractSize) <= 0)
      errs.contractSize = 'Contract size must be a positive number';
    if (!fields.currency.trim())     errs.currency     = 'Currency is required';
    if (!fields.expiryDate.trim())   errs.expiryDate   = 'Expiry date is required';
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    try {
      const result = await api.addInstrument({
        symbol:       fields.symbol.trim(),
        name:         fields.name.trim(),
        tickSize:     Number(fields.tickSize),
        contractSize: Number(fields.contractSize),
        currency:     fields.currency.trim(),
        expiryDate:   fields.expiryDate.trim(),
      });
      onSuccess(result);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to add instrument');
    }
  }

  function field(key: keyof typeof fields, label: string, type = 'text') {
    return (
      <div>
        <label htmlFor={`add-${key}`}>{label}</label>
        <input
          id={`add-${key}`}
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
      {field('symbol',       'Symbol')}
      {field('name',         'Name')}
      {field('tickSize',     'Tick Size',     'number')}
      {field('contractSize', 'Contract Size', 'number')}
      {field('currency',     'Currency')}
      {field('expiryDate',   'Expiry Date',   'date')}
      {apiError && <p role="alert">{apiError}</p>}
      <button type="submit">Submit</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ─── SetScheduleForm ──────────────────────────────────────────────────────────

interface ScheduleFormProps {
  symbol:    string;
  openTime:  string;
  closeTime: string;
  onSuccess: () => void;
  onCancel:  () => void;
}

function SetScheduleForm({ symbol, openTime: initOpen, closeTime: initClose, onSuccess, onCancel }: ScheduleFormProps) {
  const [openTime,  setOpenTime]  = useState(initOpen);
  const [closeTime, setCloseTime] = useState(initClose);
  const [apiError,  setApiError]  = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    try {
      await api.setSchedule(symbol, openTime, closeTime);
      onSuccess();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to set schedule');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label htmlFor={`sched-open-${symbol}`}>Open Time (HH:MM)</label>
        <input id={`sched-open-${symbol}`} type="text" value={openTime}
          onChange={(e) => setOpenTime(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`sched-close-${symbol}`}>Close Time (HH:MM)</label>
        <input id={`sched-close-${symbol}`} type="text" value={closeTime}
          onChange={(e) => setCloseTime(e.target.value)} />
      </div>
      {apiError && <p role="alert">{apiError}</p>}
      <button type="submit">Save</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ─── InstrumentsPage ─────────────────────────────────────────────────────────

interface RowState {
  confirmDelist:   boolean;
  showSchedule:    boolean;
  openTime:        string;
  closeTime:       string;
  actionError:     string | null;
}

const defaultRowState = (): RowState => ({
  confirmDelist: false,
  showSchedule:  false,
  openTime:      '',
  closeTime:     '',
  actionError:   null,
});

export function InstrumentsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [pageError,   setPageError]   = useState<string | null>(null);
  const [showAdd,     setShowAdd]     = useState(false);
  const [rowStates,   setRowStates]   = useState<Record<string, RowState>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await api.getInstruments();
      setInstruments(data);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to load instruments');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  function patchRow(symbol: string, patch: Partial<RowState>) {
    setRowStates((prev) => ({
      ...prev,
      [symbol]: { ...(prev[symbol] ?? defaultRowState()), ...patch },
    }));
  }

  async function handleAction(symbol: string, action: StateAction) {
    patchRow(symbol, { actionError: null });
    try {
      const updated = await api.setMarketState(symbol, action);
      setInstruments((prev) =>
        prev.map((i) => (i.symbol === symbol ? { ...i, marketState: updated.marketState } : i)),
      );
    } catch (err) {
      patchRow(symbol, { actionError: err instanceof Error ? err.message : 'Error' });
    }
  }

  async function handleDelist(symbol: string) {
    try {
      await api.delistInstrument(symbol);
      setInstruments((prev) => prev.filter((i) => i.symbol !== symbol));
      setRowStates((prev) => { const next = { ...prev }; delete next[symbol]; return next; });
    } catch (err) {
      patchRow(symbol, { actionError: err instanceof Error ? err.message : 'Error' });
    }
  }

  function handleAddSuccess(newInstrument: Instrument) {
    setShowAdd(false);
    setInstruments((prev) => [...prev, newInstrument]);
    void refresh();
  }

  return (
    <div>
      <h1>Instruments</h1>
      {pageError && <p role="alert">{pageError}</p>}

      <button onClick={() => setShowAdd((v) => !v)}>Add Instrument</button>

      {showAdd && (
        <AddInstrumentForm
          onSuccess={handleAddSuccess}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Name</th>
            <th>Tick Size</th>
            <th>Contract Size</th>
            <th>Currency</th>
            <th>Expiry Date</th>
            <th>Market State</th>
            <th>Schedule</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {instruments.map((instr) => {
            const rs = rowStates[instr.symbol] ?? defaultRowState();
            const validActions = VALID_ACTIONS[instr.marketState];
            return (
              <tr key={instr.symbol}>
                <td>{instr.symbol}</td>
                <td>{instr.name}</td>
                <td>{instr.tickSize}</td>
                <td>{instr.contractSize}</td>
                <td>{instr.currency}</td>
                <td>{instr.expiryDate}</td>
                <td><MarketStateBadge state={instr.marketState} /></td>
                <td>
                  {instr.openTime && instr.closeTime
                    ? `${instr.openTime} – ${instr.closeTime}`
                    : '—'}
                </td>
                <td>
                  {rs.actionError && <span role="alert">{rs.actionError}</span>}

                  {/* State transition buttons */}
                  {validActions.map((action) => (
                    <button key={action} onClick={() => void handleAction(instr.symbol, action)}>
                      {action.charAt(0).toUpperCase() + action.slice(1)}
                    </button>
                  ))}

                  {/* Delist */}
                  {!rs.confirmDelist ? (
                    <button onClick={() => patchRow(instr.symbol, { confirmDelist: true })}>
                      Delist
                    </button>
                  ) : (
                    <>
                      <span>Confirm delist {instr.symbol}?</span>
                      <button onClick={() => void handleDelist(instr.symbol)}>Confirm</button>
                      <button onClick={() => patchRow(instr.symbol, { confirmDelist: false })}>Cancel</button>
                    </>
                  )}

                  {/* Schedule */}
                  {!rs.showSchedule ? (
                    <button onClick={() => patchRow(instr.symbol, { showSchedule: true })}>
                      Schedule
                    </button>
                  ) : (
                    <SetScheduleForm
                      symbol={instr.symbol}
                      openTime={rs.openTime}
                      closeTime={rs.closeTime}
                      onSuccess={() => patchRow(instr.symbol, { showSchedule: false })}
                      onCancel={() => patchRow(instr.symbol, { showSchedule: false })}
                    />
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
