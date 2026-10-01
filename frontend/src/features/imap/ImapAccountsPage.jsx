import { useCallback, useState } from 'react';

import { isValidEmail } from '../dashboard/campaignValidation';
import { formatDateTime } from '../../lib/format';
import { useConfirm } from '../../providers/ConfirmProvider';
import { useToast } from '../../providers/ToastProvider';
import { Button } from '../../components/ui/Button';
import {
  CheckboxField,
  FieldGroup,
  GroupedInput,
  InputAddon,
  InputGroup,
  TextField
} from '../../components/ui/Field';
import { Callout, Panel, PanelBody, PanelHeader, PanelSpacer, PanelTitle } from '../../components/ui/Panel';
import {
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
import { TestResultsPanel } from './TestResultsPanel';
import { MAX_SELECTED_ACCOUNTS, useImapTesting } from './useImapTesting';

/**
 * IMAP setup: the server to connect to, the mailboxes to check, and which of them the next
 * check will use.
 *
 * The account-selection controls were commented out of the old page, which left
 * `toggleSelectEmail` unreachable and the manual "Check now" button permanently disabled —
 * selection could only ever be set programmatically by the auto-test flow. They are
 * restored here, because manual checking is the fallback when an auto check runs too early
 * and finds nothing.
 */
export function ImapAccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const notice = useCallback((message) => toast.show(message), [toast]);
  const imap = useImapTesting({ onNotice: notice });

  /* ---- Server credentials ------------------------------------------------ */

  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [ssl, setSsl] = useState(true);

  /**
   * Seeds the fields from the saved record, exactly once.
   *
   * Done during render with a guard — React's documented way to adjust state when an input
   * changes — rather than in an effect, which would render the empty form first and then
   * replace it.
   *
   * Once seeded it never syncs again, deliberately: a background revalidation on window
   * focus must not overwrite a host the operator is halfway through typing.
   */
  const [seeded, setSeeded] = useState(false);

  if (!seeded && !imap.isLoadingCredentials) {
    setSeeded(true);
    if (imap.credentials) {
      setHost(imap.credentials.host ?? '');
      setPort(String(imap.credentials.port ?? 993));
      setSsl(imap.credentials.ssl !== false);
    }
  }

  function handleSaveCredentials() {
    if (!host.trim()) {
      toast.warning('⚠️ Enter the IMAP host.');
      return;
    }

    imap.saveCredentials.mutate({
      host: host.trim(),
      port: Number(port) || 993,
      ssl
    });
  }

  /* ---- Adding an account ------------------------------------------------- */

  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);

  function handleAddAccount(event) {
    event.preventDefault();

    const email = newEmail.trim();
    const password = newPassword.trim();

    if (!email || !password) {
      toast.warning('⚠️ Enter both the email address and its app password.');
      return;
    }
    if (!isValidEmail(email)) {
      toast.warning('⚠️ Enter a valid email address.');
      return;
    }

    imap.addAccount.mutate(
      { email, password },
      {
        onSuccess: () => {
          setNewEmail('');
          setNewPassword('');
          setShowNewPassword(false);
        }
      }
    );
  }

  async function handleDeleteAccount(account) {
    const ok = await confirm({
      title: 'Delete this IMAP account?',
      message: [
        `${account.email} and its stored app password will be permanently deleted.`,
        'Existing test results are kept — only the ability to check this mailbox again is removed.'
      ],
      confirmLabel: 'Delete account',
      tone: 'danger'
    });

    if (ok) imap.deleteAccount.mutate(account._id);
  }

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info" icon="fa-circle-info">
        Inbox-placement testing sends a normal test campaign, then signs in to these mailboxes over
        IMAP and looks for each message in both Inbox and Spam. Use app-specific passwords — Gmail,
        Yahoo and Outlook reject account passwords for IMAP.
      </Callout>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <FieldGroup title="IMAP server" icon="fa-server">
            <TextField
              id="imap-host"
              label="IMAP host"
              placeholder="imap.gmail.com"
              autoComplete="off"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />

            <TextField
              id="imap-port"
              label="Port"
              type="number"
              inputMode="numeric"
              placeholder="993"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              hint="993 for IMAP over TLS, 143 for plain or STARTTLS."
            />

            <CheckboxField
              id="imap-ssl"
              label="Use SSL/TLS"
              checked={ssl}
              onChange={(event) => setSsl(event.target.checked)}
            />

            <Button
              variant="primary"
              icon="fa-floppy-disk"
              onClick={handleSaveCredentials}
              loading={imap.saveCredentials.isPending}
              loadingLabel="Saving…"
              className="self-start"
            >
              Save configuration
            </Button>
          </FieldGroup>

          <form onSubmit={handleAddAccount}>
            <FieldGroup title="Add a mailbox" icon="fa-user-plus">
              <TextField
                id="new-account-email"
                label="Email address"
                type="email"
                autoComplete="off"
                placeholder="user@example.com"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />

              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-account-password" className="text-sm font-semibold text-ink-700">
                  App password
                </label>
                <InputGroup>
                  <GroupedInput
                    id="new-account-password"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="App-specific password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                  <InputAddon
                    onClick={() => setShowNewPassword((current) => !current)}
                    aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  >
                    <i className={showNewPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
                  </InputAddon>
                </InputGroup>
                <span className="text-xs text-muted">
                  Stored encrypted. Adding an address that already exists replaces its password.
                </span>
              </div>

              <Button
                type="submit"
                variant="primary"
                icon="fa-plus"
                loading={imap.addAccount.isPending}
                loadingLabel="Adding…"
                className="self-start"
              >
                Add account
              </Button>
            </FieldGroup>
          </form>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader>
              <PanelTitle icon="fa-inbox">Connected mailboxes</PanelTitle>
              <PanelSpacer />
              <span className="text-xs text-muted">
                {imap.selectedEmails.length} of {MAX_SELECTED_ACCOUNTS} selected for checking
              </span>
            </PanelHeader>

            <PanelBody className="p-0">
              <TableScroll maxHeight="none" className="rounded-none border-0">
                <Table>
                  <Thead>
                    <Tr>
                      <Th align="center">Check</Th>
                      <Th>Email address</Th>
                      <Th>App password</Th>
                      <Th>Added</Th>
                      <Th align="center">Actions</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {imap.isLoadingAccounts && imap.accounts.length === 0 ? (
                      <TableEmpty colSpan={5} loading title="Loading accounts…" />
                    ) : imap.accounts.length === 0 ? (
                      <TableEmpty colSpan={5} icon="fa-user-slash" title="No mailboxes connected">
                        Add the mailbox you send test emails to, so its Inbox and Spam folders can be
                        checked.
                      </TableEmpty>
                    ) : (
                      imap.accounts.map((account) => (
                        <AccountRow
                          key={account._id}
                          account={account}
                          selected={imap.selectedEmails.includes(account.email)}
                          onToggle={() => imap.toggleSelected(account.email)}
                          onDelete={() => handleDeleteAccount(account)}
                          resolvePassword={imap.resolvePassword}
                          isDeleting={imap.deleteAccount.isPending && imap.deleteAccount.variables === account._id}
                        />
                      ))
                    )}
                  </Tbody>
                </Table>
              </TableScroll>
            </PanelBody>
          </Panel>

          <TestResultsPanel imap={imap} isAutoMode={false} />
        </div>
      </div>
    </div>
  );
}

/**
 * One mailbox row.
 *
 * The password is fetched on demand rather than with the list, because the list endpoint
 * deliberately never returns it. It is held in the hook's in-memory cache for the life of
 * the page and never written to storage.
 */
function AccountRow({ account, selected, onToggle, onDelete, resolvePassword, isDeleting }) {
  const [revealed, setRevealed] = useState(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const toast = useToast();

  async function handleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }

    setIsRevealing(true);
    try {
      const password = await resolvePassword(account._id);
      if (password) setRevealed(password);
      else toast.error('❌ Could not retrieve the password for this account.');
    } catch (err) {
      toast.error(`❌ ${err.message}`);
    } finally {
      setIsRevealing(false);
    }
  }

  return (
    <Tr className={selected ? 'bg-brand-50/60' : undefined}>
      <Td align="center">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 accent-brand-500"
          aria-label={`Include ${account.email} in the next check`}
        />
      </Td>

      <Td>
        <CellPrimary>{account.email}</CellPrimary>
      </Td>

      <Td>
        <div className="flex items-center gap-2">
          <code className="min-w-[8ch] font-mono text-xs tracking-widest text-ink-600">
            {revealed ?? '••••••••'}
          </code>
          <Button
            size="icon"
            variant="outline"
            onClick={handleReveal}
            loading={isRevealing}
            title={revealed ? 'Hide password' : 'Show password'}
            aria-label={revealed ? `Hide password for ${account.email}` : `Show password for ${account.email}`}
          >
            <i className={revealed ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
          </Button>
        </div>
      </Td>

      <Td>
        <CellSub>{formatDateTime(account.addedAt)}</CellSub>
      </Td>

      <Td align="center">
        <Button
          size="icon"
          variant="danger"
          onClick={onDelete}
          loading={isDeleting}
          title="Delete account"
          aria-label={`Delete ${account.email}`}
        >
          <i className="fa-solid fa-trash-can" aria-hidden="true" />
        </Button>
      </Td>
    </Tr>
  );
}
