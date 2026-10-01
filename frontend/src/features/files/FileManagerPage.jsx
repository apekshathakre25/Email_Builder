import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteAllFiles,
  deleteFile,
  downloadFileArtifact,
  getFilesStats,
  listFiles
} from '../../api/filesApi';
import { keys } from '../../lib/queryKeys';
import { ROUTES } from '../../lib/config';
import { cn } from '../../lib/cn';
import { capitalise, formatBytes, formatDateTime, formatNumber, percentage } from '../../lib/format';
import { useAppConfig } from '../../providers/AppConfigProvider';
import { useConfirm } from '../../providers/ConfirmProvider';
import { useToast } from '../../providers/ToastProvider';
import { queuePendingFileId } from '../dashboard/campaignFormStorage';
import { Badge } from '../../components/ui/Badge';
import { Button, ButtonRow } from '../../components/ui/Button';
import { Panel, PanelBody, PanelFooter, PanelHeader, PanelSpacer, PanelTitle } from '../../components/ui/Panel';
import { Pagination, RowsPerPage } from '../../components/ui/Pagination';
import { ProgressBar, Stat, StatList } from '../../components/ui/Stat';
import {
  CellMono,
  CellPrimary,
  CellSub,
  Table,
  TableEmpty,
  TableScroll,
  Tbody,
  Td,
  Th,
  Thead,
  Tr
} from '../../components/ui/Table';
import { useDropZone, useFileUpload } from './useFileUpload';

/**
 * Recipient file management: upload, inspect, download artifacts, delete.
 *
 * A file's `sessionId` is the campaign id, which is why copying it and sending it to the
 * dashboard are first-class actions here rather than something the operator does by hand.
 * The old page had a function for exactly that (`addFileIdToMainForm`, writing
 * localStorage['pendingFileId']) but nothing called it and nothing on the dashboard read
 * the key — so the workflow was: read the id off the screen, switch page, type it in.
 * Here "Use in campaign" navigates and carries the id.
 */
export function FileManagerPage() {
  const appConfig = useAppConfig();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(15);
  const [busyArtifact, setBusyArtifact] = useState(null);

  const listParams = { page, limit, sortBy: 'uploadDate', sortOrder: 'desc' };

  const filesQuery = useQuery({
    queryKey: keys.files.list(listParams),
    queryFn: ({ signal }) => listFiles(listParams, signal),
    // Sent/pending counts move while a campaign runs, so a stale list is actively
    // misleading about how far along a file is.
    refetchInterval: 15_000,
    placeholderData: (previous) => previous
  });

  const statsQuery = useQuery({
    queryKey: keys.files.stats,
    queryFn: ({ signal }) => getFilesStats(signal),
    refetchInterval: 30_000
  });

  const files = filesQuery.data?.files ?? [];
  const pagination = filesQuery.data?.pagination ?? { page: 1, totalPages: 1, totalFiles: 0 };
  const stats = statsQuery.data;

  const notice = useCallback((message) => toast.show(message), [toast]);

  const uploader = useFileUpload({
    maxUploadBytes: appConfig.uploads.maxUploadBytes,
    allowedExtensions: appConfig.uploads.allowedExtensions,
    onNotice: notice
  });

  const handleFile = useCallback(
    async (file) => {
      const result = await uploader.upload(file);
      if (result.ok) {
        setPage(1);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [uploader]
  );

  const isDragging = useDropZone({ onDrop: handleFile, disabled: uploader.isUploading });

  const deleteOne = useMutation({
    mutationFn: deleteFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.files.all });
      toast.success('✅ File deleted. Campaign logs are preserved.');
    },
    onError: (err) => toast.error(`❌ ${err.message}`)
  });

  const deleteEverything = useMutation({
    mutationFn: deleteAllFiles,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: keys.files.all });
      setPage(1);
      toast.success(`✅ ${data?.message ?? 'All files deleted.'}`);
    },
    onError: (err) => toast.error(`❌ ${err.message}`)
  });

  async function handleDeleteOne(file) {
    const ok = await confirm({
      title: 'Delete this recipient file?',
      message: [
        `"${file.originalName}" and its recipient list will be permanently deleted.`,
        'Campaign logs are preserved, so the record of what was already sent survives. Recipients that have not been sent to yet become unreachable for this file.'
      ],
      confirmLabel: 'Delete file',
      tone: 'danger'
    });

    if (ok) deleteOne.mutate(file.sessionId);
  }

  async function handleDeleteAll() {
    const ok = await confirm({
      title: 'Delete every recipient file?',
      message: [
        `All ${formatNumber(pagination.totalFiles)} uploaded files and their recipient lists will be permanently deleted.`,
        'Campaign logs are preserved. Any campaign still in progress loses the list it is sending from.'
      ],
      confirmLabel: 'Delete all files',
      cancelLabel: 'Keep them',
      tone: 'danger'
    });

    if (ok) deleteEverything.mutate();
  }

  async function handleDownload(file, artifact) {
    const token = `${file.sessionId}:${artifact}`;
    setBusyArtifact(token);
    try {
      await downloadFileArtifact(file.sessionId, artifact, file.originalName);
    } catch (err) {
      toast.error(`❌ ${err.message}`);
    } finally {
      setBusyArtifact(null);
    }
  }

  async function handleCopyId(sessionId) {
    try {
      // Only available in a secure context; the fallback below covers plain HTTP.
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(sessionId);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = sessionId;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      toast.success('✅ File ID copied.');
    } catch {
      toast.error(`❌ Could not copy. The File ID is ${sessionId}`);
    }
  }

  /**
   * Hands the id to the dashboard, which merges it into File IDs as it initialises.
   *
   * Via sessionStorage rather than router state so the dashboard can consume it while
   * building its initial form state, with no effect and no extra render — the mode radio
   * depends on it, and switching modes a tick later is a visible flash.
   */
  function handleUseInCampaign(sessionId) {
    queuePendingFileId(sessionId);
    navigate(ROUTES.dashboard);
  }

  return (
    <div className="flex flex-col gap-4">
      {isDragging ? <DropOverlay allowed={appConfig.uploads.allowedExtensions} /> : null}

      {stats ? (
        <Panel>
          <PanelHeader>
            <PanelTitle icon="fa-chart-pie">Across all files</PanelTitle>
            <PanelSpacer />
            <Button
              variant="secondary"
              size="sm"
              icon="fa-arrows-rotate"
              onClick={() => {
                filesQuery.refetch();
                statsQuery.refetch();
              }}
              loading={filesQuery.isFetching || statsQuery.isFetching}
              loadingLabel="Refreshing…"
            >
              Refresh
            </Button>
          </PanelHeader>
          <PanelBody>
            <StatList columns={4} className="sm:grid-cols-4">
              <Stat icon="fa-folder" label="Files" value={stats.totalFiles ?? 0} />
              <Stat icon="fa-envelope" label="Valid recipients" value={stats.totalValidEmails ?? 0} tone="brand" />
              <Stat icon="fa-paper-plane" label="Sent" value={stats.totalSentEmails ?? 0} tone="success" />
              <Stat
                icon="fa-circle-exclamation"
                label="Failed"
                value={stats.totalFailedEmails ?? 0}
                tone={stats.totalFailedEmails ? 'danger' : 'default'}
              />
            </StatList>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader>
          <PanelTitle icon="fa-cloud-arrow-up">Upload recipients</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-base text-muted">
            Drop a file anywhere on this page, or choose one below. Accepted:{' '}
            {appConfig.uploads.allowedExtensions.join(', ')} — up to{' '}
            {formatBytes(appConfig.uploads.maxUploadBytes)}.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={appConfig.uploads.allowedExtensions.join(',')}
              disabled={uploader.isUploading}
              onChange={(event) => {
                const [file] = event.target.files ?? [];
                if (file) handleFile(file);
              }}
              className={cn(
                'min-w-0 flex-1 rounded-md border border-line bg-surface text-base text-ink-700',
                'file:mr-3 file:cursor-pointer file:rounded-l-md file:border-0 file:bg-surface-muted',
                'file:px-3.5 file:py-2 file:text-base file:font-semibold file:text-ink-700',
                'hover:file:bg-ink-200 disabled:cursor-not-allowed disabled:opacity-60'
              )}
            />

            {uploader.isUploading ? (
              <Button variant="outline" icon="fa-xmark" onClick={uploader.cancel}>
                Cancel upload
              </Button>
            ) : null}
          </div>

          {uploader.isUploading ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-base text-ink-700">
                <i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true" />
                Uploading {uploader.currentFileName}
                {uploader.progress !== null ? ` — ${uploader.progress}%` : '…'}
              </p>
              {uploader.progress !== null ? (
                <ProgressBar value={uploader.progress} total={100} showLabel={false} label="Upload progress" />
              ) : null}
            </div>
          ) : null}

          <p className="text-xs text-muted">
            Every valid address is kept, including repeats — a recipient list is a list of sends,
            so a file with 16 rows means 16 emails. Invalid addresses are counted and skipped.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle icon="fa-folder-tree">
            Recipient files{pagination.totalFiles ? ` (${formatNumber(pagination.totalFiles)})` : ''}
          </PanelTitle>
          <PanelSpacer />
          <ButtonRow>
            <Button
              variant="danger"
              size="sm"
              icon="fa-trash"
              onClick={handleDeleteAll}
              disabled={files.length === 0}
              loading={deleteEverything.isPending}
              loadingLabel="Deleting…"
            >
              Delete all
            </Button>
          </ButtonRow>
        </PanelHeader>

        <PanelBody className="p-0">
          <TableScroll maxHeight="none" className="rounded-none border-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Name &amp; date</Th>
                  <Th>File ID</Th>
                  <Th>Recipients</Th>
                  <Th>Progress</Th>
                  <Th align="center">Status</Th>
                  <Th>Downloads</Th>
                  <Th align="center">Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {filesQuery.isLoading && files.length === 0 ? (
                  <TableEmpty colSpan={7} loading title="Fetching your files…" />
                ) : files.length === 0 ? (
                  <TableEmpty colSpan={7} title="No recipient files yet">
                    Upload a CSV, spreadsheet or JSON file to start a campaign.
                  </TableEmpty>
                ) : (
                  files.map((file) => {
                    const settled = (file.sentEmails ?? 0) + (file.failedEmails ?? 0);
                    const successRate = percentage(file.sentEmails ?? 0, settled);

                    return (
                      <Tr key={file.sessionId}>
                        <Td>
                          <CellPrimary>{file.originalName}</CellPrimary>
                          <CellSub>{formatDateTime(file.uploadDate)}</CellSub>
                          <CellSub>{formatBytes(file.fileSize)}</CellSub>
                        </Td>

                        <Td>
                          <div className="flex items-center gap-1.5">
                            <CellMono className="max-w-[16ch] truncate" title={file.sessionId}>
                              {file.sessionId}
                            </CellMono>
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={() => handleCopyId(file.sessionId)}
                              title="Copy File ID"
                              aria-label={`Copy File ID for ${file.originalName}`}
                            >
                              <i className="fa-solid fa-copy" aria-hidden="true" />
                            </Button>
                          </div>
                        </Td>

                        <Td>
                          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                            <CountRow label="Total" value={file.totalEmails} />
                            <CountRow label="Valid" value={file.validEmails} tone="text-success-600" />
                            <CountRow label="Invalid" value={file.invalidEmails} tone="text-danger-600" />
                            <CountRow label="Sent" value={file.sentEmails} tone="text-brand-600" />
                            <CountRow label="Failed" value={file.failedEmails} tone="text-danger-600" />
                            <CountRow label="Pending" value={file.pendingEmails} tone="text-warning-700" />
                          </dl>
                          {settled > 0 ? (
                            <p className="mt-1 border-t border-line pt-1 text-xs text-muted">
                              Success rate <span className="font-semibold text-ink-700">{successRate}%</span>
                            </p>
                          ) : null}
                        </Td>

                        <Td>
                          <div className="w-[7rem]">
                            <ProgressBar
                              value={settled}
                              total={file.validEmails}
                              tone={file.failedEmails > 0 ? 'warning' : 'brand'}
                              label={`Progress for ${file.originalName}`}
                            />
                          </div>
                        </Td>

                        <Td align="center">
                          <Badge tone={file.status}>{capitalise(file.status)}</Badge>
                        </Td>

                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            <DownloadButton
                              icon="fa-file-csv"
                              variant="info"
                              label="Original"
                              busy={busyArtifact === `${file.sessionId}:original`}
                              onClick={() => handleDownload(file, 'original')}
                            />
                            <DownloadButton
                              icon="fa-circle-check"
                              variant="success"
                              label={`Sent (${formatNumber(file.sentEmails ?? 0)})`}
                              busy={busyArtifact === `${file.sessionId}:sent`}
                              onClick={() => handleDownload(file, 'sent')}
                            />
                            <DownloadButton
                              icon="fa-circle-xmark"
                              variant="danger"
                              label={`Failed (${formatNumber(file.failedEmails ?? 0)})`}
                              busy={busyArtifact === `${file.sessionId}:failed`}
                              onClick={() => handleDownload(file, 'failed')}
                            />
                            <DownloadButton
                              icon="fa-clock"
                              variant="warning"
                              label={`Pending (${formatNumber(file.pendingEmails ?? 0)})`}
                              busy={busyArtifact === `${file.sessionId}:pending`}
                              onClick={() => handleDownload(file, 'pending')}
                            />
                          </div>
                        </Td>

                        <Td align="center">
                          <div className="flex flex-col items-stretch gap-1">
                            <Button
                              size="sm"
                              variant="primary"
                              icon="fa-arrow-right-to-bracket"
                              onClick={() => handleUseInCampaign(file.sessionId)}
                              title="Add this File ID to the campaign form"
                            >
                              Use in campaign
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              icon="fa-trash-can"
                              onClick={() => handleDeleteOne(file)}
                              loading={deleteOne.isPending && deleteOne.variables === file.sessionId}
                              loadingLabel="Deleting…"
                            >
                              Delete
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    );
                  })
                )}
              </Tbody>
            </Table>
          </TableScroll>
        </PanelBody>

        <PanelFooter>
          <RowsPerPage
            value={limit}
            onChange={(next) => {
              setLimit(next);
              setPage(1);
            }}
          />
          <PanelSpacer />
          <Pagination page={pagination.page} totalPages={pagination.totalPages} onPageChange={setPage} />
        </PanelFooter>
      </Panel>
    </div>
  );
}

function CountRow({ label, value, tone }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={cn('text-right font-mono font-semibold tabular-nums', tone ?? 'text-ink-700')}>
        {formatNumber(value ?? 0)}
      </dd>
    </>
  );
}

function DownloadButton({ icon, variant, label, busy, onClick }) {
  return (
    <Button size="sm" variant={variant} icon={icon} onClick={onClick} loading={busy} loadingLabel="…" className="w-full justify-start">
      {label}
    </Button>
  );
}

function DropOverlay({ allowed }) {
  return (
    <div
      className="fixed inset-0 z-[2000] flex flex-col items-center justify-center gap-2 border-4 border-dashed border-brand-300 bg-surface/90 backdrop-blur-sm"
      aria-hidden="true"
    >
      <i className="fa-solid fa-cloud-arrow-up animate-bounce text-5xl text-brand-500" />
      <p className="text-xl font-semibold text-ink-800">Drop your file to upload</p>
      <p className="text-base text-muted">{allowed.join(', ')}</p>
    </div>
  );
}
