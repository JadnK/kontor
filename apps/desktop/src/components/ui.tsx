import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { moneyInput, parseMoney, parseNumber, num } from "../lib/format";
import type { InvoiceStatus } from "../lib/types";

// ---------- Button ----------
type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  busy,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${className}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------- Formularfelder ----------
export function Field({
  label,
  hint,
  error,
  children,
  span,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
  span?: 1 | 2 | 3 | 4;
}) {
  const id = useId();
  return (
    <div className={`field ${span ? `span-${span}` : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  span,
  type = "text",
  placeholder,
  autoFocus,
  required,
  disabled,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  span?: 1 | 2 | 3 | 4;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error} span={span}>
      {(id) => (
        <input
          id={id}
          type={type}
          value={value ?? ""}
          placeholder={placeholder}
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 3,
  span,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (v: string) => void;
  hint?: ReactNode;
  rows?: number;
  span?: 1 | 2 | 3 | 4;
}) {
  return (
    <Field label={label} hint={hint} span={span}>
      {(id) => <textarea id={id} rows={rows} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  span,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  hint?: ReactNode;
  span?: 1 | 2 | 3 | 4;
}) {
  return (
    <Field label={label} hint={hint} span={span}>
      {(id) => (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <input id={id} type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div>
        <label htmlFor={id}>{label}</label>
        {hint ? <div className="field-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

/** Eingabe als Text, gespeichert in Cent. Übernimmt beim Verlassen des Felds. */
export function MoneyInput({
  value,
  onChange,
  id,
  className = "",
  allowNegative = false,
  ariaLabel,
}: {
  value: number | null;
  onChange: (cents: number | null) => void;
  id?: string;
  className?: string;
  allowNegative?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(moneyInput(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(moneyInput(value));
  }, [value]);
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      className={`num ${className}`}
      inputMode="decimal"
      value={text}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        setText(e.target.value);
        const c = parseMoney(e.target.value);
        if (c !== null && (allowNegative || c >= 0)) onChange(c);
        if (e.target.value.trim() === "") onChange(null);
      }}
      onBlur={() => {
        focused.current = false;
        setText(moneyInput(value));
      }}
    />
  );
}

export function MoneyField({
  label,
  value,
  onChange,
  hint,
  span,
}: {
  label: string;
  value: number | null;
  onChange: (c: number | null) => void;
  hint?: ReactNode;
  span?: 1 | 2 | 3 | 4;
}) {
  return (
    <Field label={label} hint={hint} span={span}>
      {(id) => (
        <div className="suffix-input">
          <MoneyInput id={id} value={value} onChange={onChange} />
          <span>€</span>
        </div>
      )}
    </Field>
  );
}

export function NumberInput({
  value,
  onChange,
  id,
  className = "",
  digits = 3,
  ariaLabel,
  plain,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  id?: string;
  className?: string;
  digits?: number;
  ariaLabel?: string;
  /** ohne Tausenderpunkt, z. B. für Ports */
  plain?: boolean;
}) {
  const show = (v: number | null) => (v == null ? "" : plain ? String(v) : num(v, digits));
  const [text, setText] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, digits, plain]);
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      className={`num ${className}`}
      inputMode="decimal"
      value={text}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNumber(e.target.value));
      }}
      onBlur={() => {
        focused.current = false;
        setText(show(value));
      }}
    />
  );
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  hint,
  span,
  plain,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  suffix?: string;
  hint?: ReactNode;
  span?: 1 | 2 | 3 | 4;
  plain?: boolean;
}) {
  return (
    <Field label={label} hint={hint} span={span}>
      {(id) => (
        <div className={suffix ? "suffix-input" : undefined}>
          <NumberInput id={id} value={value} onChange={onChange} plain={plain} />
          {suffix ? <span>{suffix}</span> : null}
        </div>
      )}
    </Field>
  );
}

// ---------- Layout-Bausteine ----------
export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      {title || aside ? (
        <div className="section-head">
          {title ? <h2>{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden /> Lädt …
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <p>{error}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Erneut laden
        </Button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: "Entwurf",
  ISSUED: "Offen",
  PAID: "Bezahlt",
  CANCELLED: "Storniert",
};

export function StatusBadge({ status, overdue, kind }: { status: InvoiceStatus; overdue?: boolean; kind?: "INVOICE" | "CANCELLATION" }) {
  if (kind === "CANCELLATION") return <span className="badge badge-muted">Storno</span>;
  if (overdue) return <span className="badge badge-danger">Überfällig</span>;
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? "active" : ""} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Search({ value, onChange, placeholder = "Suchen" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input className="search" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
  );
}

// ---------- Dialoge ----------
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  text,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  text: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-text">{text}</div>
    </Modal>
  );
}
