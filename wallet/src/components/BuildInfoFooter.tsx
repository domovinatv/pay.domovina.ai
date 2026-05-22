const REPO_URL = 'https://github.com/domovinatv/pay.domovina.ai';

export function BuildInfoFooter() {
  const builtAt = formatBuildTime(__APP_BUILD_TIME__);
  return (
    <footer className="py-4 text-center text-[10px] text-ink-muted select-none">
      v{__APP_VERSION__} ·{' '}
      <a
        href={`${REPO_URL}/commit/${__APP_COMMIT__}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono hover:text-ink-primary underline-offset-2 hover:underline"
        title={`Commit ${__APP_COMMIT__} · built ${__APP_BUILD_TIME__}`}
      >
        {__APP_COMMIT__}
      </a>{' '}
      · {builtAt}
    </footer>
  );
}

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}
