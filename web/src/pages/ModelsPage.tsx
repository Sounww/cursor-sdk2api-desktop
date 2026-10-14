import { Button } from "../bflabs/Button";
import { modelLooksLikeFable5 } from "../fable5";
import type { ConsoleModelCatalog } from "../api";
import { ActionLink, PageFrame } from "./shared";

export function ModelsPage({
  t,
  catalog,
  loading,
  error,
  copied,
  onRefresh,
  onCopy,
}: {
  t: {
    title: string;
    refresh: string;
    refreshing: string;
    empty: string;
    unavailable: string;
    stale: string;
    accounts: string;
    copy: string;
    copied: string;
    goAccounts: string;
  };
  catalog?: ConsoleModelCatalog;
  loading: boolean;
  error: string;
  copied: string;
  onRefresh: () => void;
  onCopy: (label: string, value: string) => void;
}) {
  const emptyPool = catalog?.reason === "cursor_account_pool_empty";
  return (
    <PageFrame
      title={t.title}
      actions={
        <Button variant="secondary" size="sm" loading={loading} onClick={onRefresh}>
          {loading ? t.refreshing : t.refresh}
        </Button>
      }
    >
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {catalog?.status === "stale" ? <p className="note">{t.stale}</p> : null}
      {emptyPool ? (
        <p className="empty">
          {t.empty} <ActionLink href="#/accounts">{t.goAccounts}</ActionLink>
        </p>
      ) : null}
      {!emptyPool && catalog && catalog.models.length === 0 ? <p className="empty">{t.unavailable}</p> : null}
      <ul className="model-plain">
        {catalog?.models.map((model) => {
          const label = `model:${model.id}`;
          return (
            <li key={model.id}>
              <div>
                <strong>{model.display_name || model.id}</strong>
                <span className="sub">{model.id}</span>
                <span className="sub">{t.accounts}: {model.accounts.map((account) => account.key_hint).join("  ")}</span>
              </div>
              <div className="desktop-actions">
                {modelLooksLikeFable5(model.id, model.display_name) ? <span className="tag">Fable 5</span> : null}
                <Button variant="secondary" size="sm" onClick={() => onCopy(label, model.id)}>
                  {copied === label ? t.copied : t.copy}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </PageFrame>
  );
}
