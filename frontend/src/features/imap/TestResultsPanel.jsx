import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ROUTES } from '../../lib/config';
import { capitalise, formatDateParts, formatTimeOnly, truncateMiddle } from '../../lib/format';
import { useConfirm } from '../../providers/ConfirmProvider';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Panel, PanelBody, PanelHeader, PanelSpacer, PanelTitle, Toolbar } from '../../components/ui/Panel';
import {
  CellActions,
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
import { TestResultDetailsModal } from './TestResultDetailsModal';

/**
 * Inbox-placement results for the dashboard sidebar.
 *
 * Reads from the shared useImapTesting hook so the dashboard's Auto IMAP Test, the
 * manual check button and this table all operate on one selection and one result set.
 */
export function TestResultsPanel({ imap, isAutoMode }) {
  const confirm = useConfirm();
  const [detailsFor, setDetailsFor] = useState(null);

  const { results, isLoadingResults, pendingCount, isChecking } = imap;

  async function handleDeleteAll() {
    const ok = await confirm({
      title: 'Delete all test results?',
      message: [
        'Every inbox-placement test result will be permanently deleted.',
        'The emails themselves are unaffected — this only clears the record of where they landed.'
      ],
      confirmLabel: 'Delete all',
      cancelLabel: 'Keep them',
      tone: 'danger'
    });

    if (ok) await imap.deleteAllResults();
  }

  async function handleDelete(result) {
    const ok = await confirm({
      title: 'Delete this test result?',
      message: `The placement record for ${result.testEmail} will be permanently deleted.`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });

    if (ok) imap.deleteResult.mutate(result.testId);
  }

  return (
    <>
      <Panel>
        <PanelHeader>
          <PanelTitle icon="fa-chart-bar">Test Results</PanelTitle>
          <PanelSpacer />
          <Badge tone={isAutoMode ? 'auto' : 'neutral'} showIcon={false}>
            {isAutoMode ? 'Auto testing' : 'Manual testing'}
          </Badge>
        </PanelHeader>

        <PanelBody>
          <Toolbar>
            <Button
              variant="info"
              size="sm"
              icon="fa-sync-alt"
              onClick={imap.refreshResults}
              loading={isLoadingResults}
              loadingLabel="Refreshing…"
            >
              Refresh
            </Button>

            <Button
              variant="accent"
              size="sm"
              icon="fa-magnifying-glass"
              onClick={imap.checkPending}
              loading={isChecking}
              loadingLabel="Checking…"
              disabled={pendingCount === 0 || imap.selectedEmails.length === 0}
              title={
                pendingCount === 0
                  ? 'No test emails are waiting to be checked.'
                  : imap.selectedEmails.length === 0
                    ? 'Select at least one IMAP account on the IMAP Setup page.'
                    : undefined
              }
            >
              Check now{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </Button>

            <Button
              variant="danger"
              size="sm"
              icon="fa-trash"
              onClick={handleDeleteAll}
              disabled={results.length === 0}
            >
              Delete all
            </Button>

            {/* A router Link, so Ctrl/Cmd-click still opens a new tab — which is how
                operators use it: configure an account without losing the campaign draft
                in this tab. */}
            <Link to={ROUTES.imapAccounts} className="no-underline">
              <Button variant="ghost" size="sm" icon="fa-user-gear">
                Manage accounts
              </Button>
            </Link>
          </Toolbar>

          {imap.selectedEmails.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-ink-700">
              <i className="fa-solid fa-envelope-circle-check text-brand-500" aria-hidden="true" />
              <span className="font-semibold">Checking:</span>
              <span className="break-all">{imap.selectedEmails.join(', ')}</span>
            </p>
          ) : null}

          <TableScroll maxHeight="min(32rem, 60vh)">
            <Table>
              <Thead>
                <Tr>
                  <Th>Test email</Th>
                  <Th>Sending IP</Th>
                  <Th align="center">Status</Th>
                  <Th>Date</Th>
                  <Th align="center">Actions</Th>
                </Tr>
              </Thead>
              <Tbody>
                {isLoadingResults && results.length === 0 ? (
                  <TableEmpty colSpan={5} loading title="Loading test results…" />
                ) : results.length === 0 ? (
                  <TableEmpty colSpan={5} title="No test results yet">
                    Send a test email with Auto IMAP Test enabled to see where it landed.
                  </TableEmpty>
                ) : (
                  results.map((result) => {
                    const { date, time } = formatDateParts(result.sentAt);
                    const checkedAt = formatTimeOnly(result.checkedAt);

                    return (
                      <Tr key={result.testId}>
                        <Td>
                          {result.messageId ? (
                            <CellSub className="font-mono" title={`Message-ID: ${result.messageId}`}>
                              {truncateMiddle(result.messageId, 24)}
                            </CellSub>
                          ) : null}
                          <CellPrimary title={result.testEmail}>{truncateMiddle(result.testEmail, 28)}</CellPrimary>
                          {result.subject ? <CellSub title={result.subject}>{truncateMiddle(result.subject, 34)}</CellSub> : null}
                        </Td>

                        <Td>
                          <CellMono title={result.ipAddress}>{truncateMiddle(result.ipAddress, 18)}</CellMono>
                        </Td>

                        <Td align="center">
                          <Badge tone={result.status}>{capitalise(result.status)}</Badge>
                        </Td>

                        <Td>
                          <CellPrimary className="font-normal">{date}</CellPrimary>
                          <CellSub>{time}</CellSub>
                          {checkedAt ? (
                            <CellSub className="text-success-600">
                              <i className="fa-solid fa-check mr-1" aria-hidden="true" />
                              {checkedAt}
                            </CellSub>
                          ) : null}
                        </Td>

                        <Td align="center">
                          <CellActions>
                            <Button
                              size="icon"
                              variant="primary"
                              onClick={() => setDetailsFor(result)}
                              title="View details"
                              aria-label={`View details for ${result.testEmail}`}
                            >
                              <i className="fa-solid fa-eye" aria-hidden="true" />
                            </Button>
                            <Button
                              size="icon"
                              variant="danger"
                              onClick={() => handleDelete(result)}
                              title="Delete"
                              aria-label={`Delete result for ${result.testEmail}`}
                            >
                              <i className="fa-solid fa-trash" aria-hidden="true" />
                            </Button>
                          </CellActions>
                        </Td>
                      </Tr>
                    );
                  })
                )}
              </Tbody>
            </Table>
          </TableScroll>
        </PanelBody>
      </Panel>

      <TestResultDetailsModal
        open={Boolean(detailsFor)}
        result={detailsFor}
        onClose={() => setDetailsFor(null)}
      />
    </>
  );
}
