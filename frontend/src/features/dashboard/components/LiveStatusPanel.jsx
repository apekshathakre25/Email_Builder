import { Panel, PanelBody, PanelHeader, PanelSpacer, PanelTitle } from '../../../components/ui/Panel';
import { Stat, StatList } from '../../../components/ui/Stat';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';

/**
 * Live counters for the running campaign.
 *
 * Two panels rather than one, colour-coded green and blue, because the old dashboard
 * kept them separate and the distinction is real: a test send is a handful of
 * placement checks with no notion of total or pending, while a bulk campaign has six
 * meaningful counters. One panel trying to serve both showed four dashes half the time.
 *
 * Every number here comes from a single /status response. That matters: the old client
 * computed `pending` itself and also wrote an optimistic value at submit — subtracting
 * *enqueued* work rather than *settled* work — which made Pending the one counter that
 * moved instantly and then visibly jumped back up on the next poll. One definition, one
 * source.
 */

export function TestLiveStatus({ status, onRefresh, isRefreshing }) {
  return (
    <Panel variant="test">
      <PanelHeader>
        <PanelTitle icon="fa-flask" variant="test">
          Test Mode Live Status
        </PanelTitle>
      </PanelHeader>

      <PanelBody>
        <StatList columns={2}>
          <Stat icon="fa-paper-plane" label="Total Sent" value={status?.sent ?? 0} tone="success" live surface="success" />
          <Stat
            icon="fa-circle-exclamation"
            label="Total Failed"
            value={status?.failed ?? 0}
            tone={status?.failed ? 'danger' : 'default'}
            live
            surface="success"
          />
        </StatList>

        <Button
          variant="success"
          size="sm"
          icon="fa-sync-alt"
          onClick={onRefresh}
          loading={isRefreshing}
          loadingLabel="Refreshing…"
          className="self-start"
        >
          Refresh current status
        </Button>
      </PanelBody>
    </Panel>
  );
}

export function BulkLiveStatus({ status, batchLimit, isStopped, campaignStatus }) {
  return (
    <Panel variant="bulk">
      <PanelHeader>
        <PanelTitle icon="fa-chart-line" variant="bulk">
          Bulk Mode Live Status
        </PanelTitle>
        <PanelSpacer />
        {isStopped ? (
          <Badge tone="stopped">Stopped</Badge>
        ) : campaignStatus ? (
          <Badge tone={campaignStatus === 'in_progress' ? 'in_progress' : campaignStatus}>
            {campaignStatus === 'in_progress' ? 'In progress' : campaignStatus}
          </Badge>
        ) : null}
      </PanelHeader>

      <PanelBody>
        <StatList columns={2}>
          <Stat icon="fa-list" label="Total" value={status?.total ?? 0} surface="brand" />
          {/* The server's own count of enqueued-but-unsettled work, not a local guess. */}
          <Stat icon="fa-clock" label="Queue" value={status?.sending ?? 0} tone="info" live surface="brand" />
          {/* What was typed into Limit for the batch in flight — a local, known value. */}
          <Stat icon="fa-swatchbook" label="Limit" value={batchLimit ?? 0} surface="brand" />
          <Stat
            icon="fa-hourglass-half"
            label="Pending"
            value={status?.pending ?? 0}
            tone="warning"
            live
            surface="brand"
          />
          <Stat icon="fa-paper-plane" label="Total Sent" value={status?.sent ?? 0} tone="success" live surface="brand" />
          <Stat
            icon="fa-circle-exclamation"
            label="Total Failed"
            value={status?.failed ?? 0}
            tone={status?.failed ? 'danger' : 'default'}
            live
            surface="brand"
          />
        </StatList>

        {/*
          Recipients that were enqueued and then had their jobs discarded by a stop. They
          are counted as released but are not in flight and never will be, so they are
          worth naming rather than leaving as an unexplained gap between Queue and Pending.
        */}
        {status?.resendQueued > 0 ? (
          <p className="text-xs text-muted">
            <i className="fa-solid fa-rotate-left mr-1.5" aria-hidden="true" />
            {status.resendQueued.toLocaleString()} recipient
            {status.resendQueued === 1 ? '' : 's'} held back from a previous stop. They are sent first
            when you resume.
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/**
 * The persistent campaign status line — the old `#errors` element.
 *
 * Kept as a permanent line rather than folded into the toast system, because it is
 * state rather than an event: "Campaign is running — 412 sent" must stay on screen. It
 * is a live region here, which it was not before, so the counters are announced as they
 * change.
 */
export function ResultsLine({ message, onDownloadLog, isDownloadingLog, canDownloadLog }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5">
      <p
        className="flex items-start gap-2 text-base text-ink-700"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <i className="fa-solid fa-circle-info mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">
          {message || 'Results will appear here once a campaign is submitted.'}
        </span>
      </p>

      {/*
        Offered whenever the campaign has recorded a failure, because that is exactly when the
        status line says "download the log for details" — a message the previous UI showed
        while having no way to act on it, since its log-download button had been removed from
        the markup.
      */}
      {canDownloadLog ? (
        <Button
          variant="secondary"
          size="sm"
          icon="fa-download"
          onClick={onDownloadLog}
          loading={isDownloadingLog}
          loadingLabel="Preparing…"
          className="self-start"
        >
          Download per-recipient log
        </Button>
      ) : null}
    </div>
  );
}
