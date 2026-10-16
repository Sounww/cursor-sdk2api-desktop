import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../bflabs/Button";
import { getLogs, type LogEntry, type LogFileInfo } from "../api";
import { PageFrame } from "./shared";

const POLL_MS = 2_000;
const MAX_ENTRIES = 5_000;
const LEVELS = ["all", "info", "warn", "error"] as const;
type LevelFilter = (typeof LEVELS)[number];
type Row = LogEntry & { id: number; search: string };

export function LogsPage({
  t,
  copied,
  onCopy,
}: {
  t: {
    title: string;
    refresh: string;
    refreshing: string;
    follow: string;
    date: string;
    today: string;
    level: string;
    all: string;
    filter: string;
    filterPlaceholder: string;
    copyDir: string;
    copied: string;
    dir: string;
    empty: string;
    noMatch: string;
    disabled: string;
    lines: string;
  };
  copied: string;
  onCopy: (label: string, value: string) => void;
}) {
  // "" follows the server's current day, including across midnight.
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [today, setToday] = useState("");
  const [dir, setDir] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [filter, setFilter] = useState("");

  const shownDate = useRef("");
  const offset = useRef(0);
  const generation = useRef(0);
  const polling = useRef(false);
  const nextId = useRef(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const toRows = (entries: LogEntry[]): Row[] =>
    entries.map((entry) => ({
      ...entry,
      id: nextId.current++,
      search: `${entry.msg} ${fieldText(entry.fields)}`.toLowerCase(),
    }));

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const page = await getLogs({ date: date || undefined });
      if (mine !== generation.current) return;
      setError("");
      setEnabled(page.enabled);
      if (!page.enabled) {
        setRows([]);
        setFiles([]);
        return;
      }
      setFiles(page.files);
      setToday(page.today);
      setDir(page.dir);
      shownDate.current = page.date;
      offset.current = page.next_offset;
      stick.current = true;
      setRows(toRows(page.entries));
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [date]);

  const poll = useCallback(async () => {
    if (polling.current || !shownDate.current) return;
    const mine = generation.current;
    polling.current = true;
    try {
      const page = await getLogs({ date: shownDate.current, offset: offset.current });
      if (mine !== generation.current || !page.enabled) return;
      setError("");
      setFiles(page.files);
      setToday(page.today);
      if (date === "" && page.today !== shownDate.current) {
        void reload();
        return;
      }
      offset.current = page.next_offset;
      if (page.entries.length > 0) {
        setRows((current) => {
          const merged = current.concat(toRows(page.entries));
          return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
        });
      }
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      polling.current = false;
    }
  }, [date, reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const live = enabled && (date === "" || date === today);
  useEffect(() => {
    if (!follow || !live) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [follow, live, poll]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view && stick.current) view.scrollTop = view.scrollHeight;
  }, [rows, level, filter]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return rows.filter(
      (row) => (level === "all" || row.level === level) && (!needle || row.search.includes(needle)),
    );
  }, [rows, level, filter]);

  return (
    <PageFrame
      title={t.title}
      actions={
        <>
          <Button variant="secondary" size="sm" disabled={!dir} onClick={() => onCopy("logs:dir", dir)}>
            {copied === "logs:dir" ? t.copied : t.copyDir}
          </Button>
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void reload()}>
            {loading ? t.refreshing : t.refresh}
          </Button>
        </>
      }
    >
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {!enabled ? (
        <p className="note">{t.disabled}</p>
      ) : (
        <>
          <div className="log-toolbar">
            <label className="field log-field">
              <span>{t.date}</span>
              <select value={date} onChange={(event) => setDate(event.target.value)}>
                <option value="">{today ? `${t.today} · ${today}` : t.today}</option>
                {files
                  .filter((file) => file.date !== today)
                  .map((file) => (
                    <option key={file.date} value={file.date}>
                      {file.date} · {formatSize(file.size)}
                    </option>
                  ))}
              </select>
            </label>
            <div className="log-levels" role="group" aria-label={t.level}>
              <span>{t.level}</span>
              <div className="stream">
                {LEVELS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={level === value ? "is-on" : ""}
                    aria-pressed={level === value}
                    onClick={() => setLevel(value)}
                  >
                    {value === "all" ? t.all : value}
                  </button>
                ))}
              </div>
            </div>
            <label className="field log-field log-filter">
              <span>{t.filter}</span>
              <input
                type="search"
                value={filter}
                placeholder={t.filterPlaceholder}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <label className="log-follow">
              <input
                type="checkbox"
                checked={follow && live}
                disabled={!live}
                onChange={(event) => setFollow(event.target.checked)}
              />
              {t.follow}
            </label>
          </div>
          {dir ? <p className="sub log-dir">{t.dir}: <span className="mono">{dir}</span></p> : null}
          <div
            ref={viewRef}
            className="log-view"
            role="log"
            onScroll={(event) => {
              const view = event.currentTarget;
              stick.current = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
            }}
          >
            {visible.length === 0 ? (
              <p className="empty">{rows.length > 0 ? t.noMatch : t.empty}</p>
            ) : (
              visible.map((row) => {
                const extra = fieldText(row.fields);
                return (
                  <div key={row.id} className={`log-line log-${row.level}`}>
                    <span className="log-time">{formatTime(row.time)}</span>
                    <span className="log-level">{row.level}</span>
                    <span className="log-msg">
                      {row.msg}
                      {extra ? <span className="log-fields"> {extra}</span> : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <p className="sub log-count">
            {visible.length} / {rows.length} {t.lines}
          </p>
        </>
      )}
    </PageFrame>
  );
}

function fieldText(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

function formatTime(time?: string): string {
  if (!time) return "--:--:--";
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return time;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
