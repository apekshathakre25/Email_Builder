
let imapCredentials = {
    host: '',
    port: 993,
    ssl: true
};

let testEmailAccounts = [];
let selectedEmails = []; 
let autoImapTestEnabled = false;
let currentTestType = 'manual'; 


window._accountPasswordCache = {};


async function loadImapData() {
    try {
    
        const credsRes = await fetch('/imap/credentials');
        const credsData = await credsRes.json();
        if (credsData.success && credsData.credentials) {
            imapCredentials = credsData.credentials;
            const hostInput = document.getElementById('imap-host');
            const portInput = document.getElementById('imap-port');
            const sslInput = document.getElementById('imap-ssl');
            if (hostInput) hostInput.value = imapCredentials.host || '';
            if (portInput) portInput.value = imapCredentials.port || 993;
            if (sslInput) sslInput.checked = imapCredentials.ssl !== false;
        }

 
        await refreshEmailAccounts();
    } catch (err) {
        console.error('Failed to load IMAP data from DB:', err);
    }
}


async function refreshEmailAccounts() {
    try {
        const res = await fetch('/imap/email-accounts');
        const data = await res.json();
        if (data.success) {
            testEmailAccounts = data.accounts; 
            renderEmailList();
        }
    } catch (err) {
        console.error('Failed to fetch email accounts:', err);
    }
}


document.getElementById('save-imap-credentials')?.addEventListener('click', async function () {
    const host = document.getElementById('imap-host').value.trim();
    const port = parseInt(document.getElementById('imap-port').value) || 993;
    const ssl = document.getElementById('imap-ssl').checked;

    if (!host) {
        showError('⚠️ Please enter IMAP host');
        return;
    }

    try {
        const res = await fetch('/imap/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, ssl })
        });
        const data = await res.json();
        if (data.success) {
            imapCredentials = { host, port, ssl };
            showError('✅ IMAP credentials saved successfully!');
        } else {
            showError('❌ Failed to save: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        showError('❌ Failed to save IMAP credentials: ' + err.message);
    }
});


document.getElementById('toggle-test-email-pass')?.addEventListener('click', function () {
    const passInput = document.getElementById('test-email-password');
    const eyeIcon = document.getElementById('test-email-pass-eye');

    if (passInput.type === 'password') {
        passInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash');
    } else {
        passInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
    }
});


document.getElementById('add-test-email')?.addEventListener('click', async function () {
    const email = document.getElementById('test-email').value.trim();
    const password = document.getElementById('test-email-password').value.trim();

    if (!email || !password) {
        showError('⚠️ Please enter both email and app password');
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showError('⚠️ Please enter a valid email address');
        return;
    }

    try {
        const res = await fetch('/imap/email-accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) {
            showError('❌ ' + (data.error || 'Failed to add account'));
            return;
        }


        const emailInput = document.getElementById('test-email');
        const passInput = document.getElementById('test-email-password');
        if (emailInput) emailInput.value = '';
        if (passInput) passInput.value = '';

        await refreshEmailAccounts();
        showError(`✅ Email account ${email} added successfully!`);
    } catch (err) {
        showError('❌ Failed to add email account: ' + err.message);
    }
});


function renderEmailList() {
    const listContainer = document.getElementById('test-emails-list');
    if (!listContainer) return;

    if (testEmailAccounts.length === 0) {
        listContainer.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #71717a; padding: 40px; font-style: italic;">No email accounts connected</td></tr>';
        return;
    }

    let html = '';

    testEmailAccounts.forEach((account) => {
        const isSelected = selectedEmails.includes(account.email);
        const accountId = account._id || account._id?.toString();

        html += `
      <tr class="${isSelected ? 'bg-zinc-50' : ''} border-b border-zinc-100 hover:bg-zinc-50/50 transition-colors">
        <!-- <td class="p-4 border-r border-zinc-50">
          <div class="flex items-center justify-center">
            <input type="checkbox" id="check-${accountId}" ${isSelected ? 'checked' : ''} 
                   onchange="toggleSelectEmail('${account.email}')" 
                   class="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 cursor-pointer" />
          </div>
        </td> -->
        <td class="p-4">
          <div class="font-medium text-zinc-900">${account.email}</div>
        </td>
        <td class="p-4">
          <div class="flex items-center gap-2">
            <div id="pass-text-${accountId}" class="font-mono text-xs text-zinc-500 tracking-widest min-w-[80px]">••••••••</div>
            <button onclick="toggleAccountPassword('${accountId}', this)" class="text-zinc-400 hover:text-zinc-600 focus:outline-none" title="Show/Hide Password">
              <i class="fa-solid fa-eye"></i>
            </button>
          </div>
        </td>
        <td class="p-4 text-xs text-zinc-500">
          ${new Date(account.addedAt).toLocaleDateString()} ${new Date(account.addedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </td>
        <td class="p-4 text-right">
          <div class="flex justify-end gap-2">
            <button onclick="deleteEmail('${accountId}')" 
                    class="h-8 w-8 inline-flex items-center justify-center text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors border border-transparent hover:border-red-100"
                    title="Delete Account">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
    });

    listContainer.innerHTML = html;
}


async function getAccountPassword(accountId) {
    if (window._accountPasswordCache[accountId]) return window._accountPasswordCache[accountId];
    try {
        const res = await fetch(`/imap/account-password/${accountId}`);
        const data = await res.json();
        if (data.success && data.password) {
            window._accountPasswordCache[accountId] = data.password;
            return data.password;
        }
    } catch (err) {
        console.error('Failed to fetch account password:', err);
    }
    return null;
}

window.toggleAccountPassword = async function(accountId, btnEl) {
    const textEl = document.getElementById(`pass-text-${accountId}`);
    const iconEl = btnEl.querySelector('i');
    
    if (!textEl || !iconEl) return;
    
    const isHidden = textEl.textContent.includes('•');
    
    if (isHidden) {
  
        const password = await getAccountPassword(accountId);
        if (password) {
            textEl.textContent = password;
            textEl.classList.remove('tracking-widest');
            textEl.classList.add('tracking-normal');
            iconEl.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            showError('❌ Could not retrieve password');
        }
    } else {
 
        textEl.textContent = '••••••••';
        textEl.classList.remove('tracking-normal');
        textEl.classList.add('tracking-widest');
        iconEl.classList.replace('fa-eye-slash', 'fa-eye');
    }
};


function toggleSelectEmail(email) {
    const index = selectedEmails.indexOf(email);

    if (index > -1) {
        selectedEmails.splice(index, 1);
        showError(`✅ Deselected email: ${email}`);


    } else {
 
        if (selectedEmails.length >= 5) {
            showError('⚠️ Maximum 5 email accounts can be selected at once');
            return;
        }


        if (selectedEmails.length > 0) {
            const selectedDomain = selectedEmails[0].split('@')[1];
            const newDomain = email.split('@')[1];

            if (selectedDomain !== newDomain) {
                showError(`⚠️ Please select emails from the same domain (@${selectedDomain})`);
                return;
            }
        }


        selectedEmails.push(email);
        showError(`✅ Selected email: ${email}`);
    }

    renderEmailList();
    updateCurrentEmailDisplay();
}

async function deleteEmail(id) {
    const account = testEmailAccounts.find(acc => acc._id === id || acc._id?.toString() === id?.toString());
    const emailLabel = account ? account.email : id;

    const ok = window.showDialog ? await window.showDialog({
        title: 'Delete Account',
        message: `Are you sure you want to permanently delete ${emailLabel}?`,
        type: 'warning',
        confirm: true
    }) : confirm(`Are you sure you want to delete ${emailLabel}?`);

    if (ok) {
        try {
            const res = await fetch(`/imap/email-accounts/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) {
                showError('❌ ' + (data.error || 'Failed to delete account'));
                return;
            }

            const selectedIndex = selectedEmails.indexOf(emailLabel);
            if (selectedIndex > -1) {
                selectedEmails.splice(selectedIndex, 1);
                updateCurrentEmailDisplay();
            }

            delete window._accountPasswordCache[id];

            await refreshEmailAccounts();
            showError(`✅ Email account ${emailLabel} deleted`);
        } catch (err) {
            showError('❌ Failed to delete: ' + err.message);
        }
    }
}


function updateCurrentEmailDisplay() {
    const display = document.getElementById('current-email-display');
    const text = document.getElementById('current-email-text');

    if (display && text) {
        if (selectedEmails.length > 0) {
            text.textContent = selectedEmails.join(', ');
            display.style.display = 'block';
        } else {
            display.style.display = 'none';
        }
    }
}


document.getElementById('check-both')?.addEventListener('click', async function () {
    if (selectedEmails.length === 0) {
        showError('⚠️ Please select at least one email account first');
        return;
    }

    if (!imapCredentials.host) {
        showError('⚠️ Please configure IMAP credentials first');
        return;
    }

    const button = this;
    const originalHTML = button.innerHTML;

    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'not-allowed';
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

    showError(`⏳ Checking ${selectedEmails.length} email account(s) for pending test emails...`);

    try {

        const pendingResponse = await fetch('/imap/test-results?limit=100');
        const pendingData = await pendingResponse.json();

        let pendingResults = [];
        if (pendingData.success && pendingData.results) {

            pendingResults = pendingData.results.filter(r => r.status === 'pending');
        }

        if (pendingResults.length === 0) {
            showError('ℹ️ No pending test emails found. Send test emails first.');
            return;
        }

        showError(`⏳ Found ${pendingResults.length} pending test email(s). Checking IMAP servers...`);

        await loadTestResults();

        const testIds = pendingResults.map(r => r.testId);

 
        const checkPromises = selectedEmails.map(async (email) => {
            const account = testEmailAccounts.find(acc => acc.email === email);
            if (!account) {
                return {
                    email,
                    error: 'Account not found',
                    results: []
                };
            }

            const pwd = await getAccountPassword(account._id);
            if (!pwd) {
                return { email, error: 'Could not retrieve account password', results: [] };
            }

            const requestBody = {
                host: imapCredentials.host,
                port: imapCredentials.port,
                ssl: imapCredentials.ssl,
                email: account.email,
                password: pwd,
                testIds: testIds
            };

            try {

                const response = await fetch('/imap/check-auto-test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody)
                });

                const data = await response.json();

                await loadTestResults();

                return {
                    email: account.email,
                    results: response.ok ? (data.results || []) : [],
                    error: !response.ok ? data.error : null
                };
            } catch (error) {
                return {
                    email: account.email,
                    error: error.message,
                    results: []
                };
            }
        });


        const results = await Promise.all(checkPromises);


        const totalFound = results.reduce((sum, r) => sum + r.results.length, 0);
        const errors = results.filter(r => r.error).length;


        await loadTestResults();

        if (errors === 0) {
            if (totalFound > 0) {
                showError(`✅ Manual check completed: Found ${totalFound} test email(s) and updated their status`);
            } else {
                showError(`ℹ️ Manual check completed: No pending test emails found in inbox or spam folders`);
            }
        } else {
            showError(`⚠️ Manual check completed with ${errors} error(s): Found ${totalFound} test email(s)`);
        }
    } catch (error) {
        console.error('Error checking emails:', error);
        showError('❌ Failed to check emails: ' + error.message);
    } finally {

        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.innerHTML = originalHTML;


        await loadTestResults();
    }
});


function changeSpamPage(email, direction) {
    if (!window.spamPagination) {
        window.spamPagination = {};
    }
    if (!window.spamPagination[email]) {
        window.spamPagination[email] = 0;
    }

    const currentResults = window.lastSpamResults.find(r => r.email === email);
    if (!currentResults) return;

    const emailsPerPage = 5;
    const totalPages = Math.ceil(Math.min(currentResults.spam.length, 20) / emailsPerPage);

    let newPage = window.spamPagination[email] + direction;
    if (newPage < 0) newPage = 0;
    if (newPage >= totalPages) newPage = totalPages - 1;

    window.spamPagination[email] = newPage;

   
    if (window.lastSpamResults) {
        renderSpamMailsMultiple(window.lastSpamResults);
    }
}


window.addEventListener('DOMContentLoaded', function () {
    loadImapData();
    setupAutoImapTestToggle();
    setupTestModeToggle();
    setupTestResultsHandlers();
});


function setupAutoImapTestToggle() {
    const bulkRadio = document.getElementById('bulk');
    const testRadio = document.getElementById('test');
    const autoImapCheckbox = document.getElementById('auto-imap-test');

    if (!bulkRadio || !testRadio || !autoImapCheckbox) return;

    // Enable/disable checkbox based on mode
    function updateCheckboxState() {
        if (testRadio.checked) {
            autoImapCheckbox.disabled = false;
        } else {
            autoImapCheckbox.disabled = true;
            autoImapCheckbox.checked = false;
            autoImapTestEnabled = false;
        }
    }

    bulkRadio.addEventListener('change', updateCheckboxState);
    testRadio.addEventListener('change', updateCheckboxState);

    autoImapCheckbox.addEventListener('change', function () {
        autoImapTestEnabled = this.checked;

        if (autoImapTestEnabled) {
            if (testEmailAccounts.length === 0) {
                showError('⚠️ Please add test email accounts first');
                this.checked = false;
                autoImapTestEnabled = false;
                return;
            }


            if (!imapCredentials.host) {
                showError('⚠️ Please configure IMAP credentials first');
                this.checked = false;
                autoImapTestEnabled = false;
                return;
            }

  
            const testRecpField = document.getElementById('test-recp');
            const testRecipients = testRecpField ? testRecpField.value.trim() : '';

            if (!testRecipients) {
                showError('⚠️ Please enter test recipients first');
                this.checked = false;
                autoImapTestEnabled = false;
                return;
            }


            const recipients = testRecipients.split(/[,\n]/).map(e => e.trim()).filter(e => e);
            const missingAccounts = recipients.filter(r => !testEmailAccounts.some(acc => acc.email === r));

            if (missingAccounts.length > 0) {
                showError(`⚠️ Please add test email accounts for: ${missingAccounts.join(', ')}`);
                this.checked = false;
                autoImapTestEnabled = false;
                return;
            }

            currentTestType = 'auto';
            updateTestModeIndicator();
            showError('✅ Auto IMAP Test enabled - emails will be checked automatically');
        } else {
            currentTestType = 'manual';
            updateTestModeIndicator();
            showError('ℹ️ Auto IMAP Test disabled - use manual checking');
        }
    });

    updateCheckboxState();
}


function setupTestModeToggle() {
    const testRadio = document.getElementById('test');
    const bulkRadio = document.getElementById('bulk');

    if (testRadio) {
        testRadio.addEventListener('change', function () {
            if (this.checked) {
                currentTestType = 'manual';
                updateTestModeIndicator();
                loadTestResults();
            }
        });
    }

    if (bulkRadio) {
        bulkRadio.addEventListener('change', function () {
            if (this.checked) {
                currentTestType = 'manual';
                autoImapTestEnabled = false;
                updateTestModeIndicator();
            }
        });
    }
}


function updateTestModeIndicator() {
    const indicator = document.getElementById('test-mode-indicator');
    if (!indicator) return;

    if (currentTestType === 'auto') {
        indicator.textContent = 'Auto Testing';
        indicator.className = 'badge badge--auto';
    } else {
        indicator.textContent = 'Manual Testing';
        indicator.className = 'badge badge--neutral';
    }
}

function setupTestResultsHandlers() {
    const refreshBtn = document.getElementById('refresh-test-results');
    const clearBtn = document.getElementById('clear-test-results');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadTestResults);
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', async function () {
            if (!confirm('Are you sure you want to delete ALL test results? This cannot be undone.')) return;

            try {
                const results = await fetch(`/imap/test-results?limit=1000`);
                const data = await results.json();

                if (data.success && data.results) {
                    let deleted = 0;
                    for (const result of data.results) {
                        try {
                            await fetch(`/imap/test-results/${result.testId}`, {
                                method: 'DELETE'
                            });
                            deleted++;
                        } catch (err) {
                            console.error(`Error deleting ${result.testId}:`, err);
                        }
                    }

                    showError(`✅ Deleted ${deleted} test result(s)`);
                } else {
                    showError('ℹ️ No test results to delete');
                }

                loadTestResults();
            } catch (error) {
                console.error('Error clearing results:', error);
                showError('❌ Failed to clear test results');
            }
        });
    }


    loadTestResults();
}


async function loadTestResults() {
    try {

        const response = await fetch(`/imap/test-results?limit=100`);
        const data = await response.json();

        if (data.success) {
            renderTestResults(data.results || []);
        }
    } catch (error) {
        console.error('Error loading test results:', error);
    }
}


function renderTestResults(results) {
    const tbody = document.getElementById('test-results-body');
    if (!tbody) return;

    if (results.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="empty-state">
                        <i class="fa-solid fa-inbox"></i>
                        No test results available. Send test emails to see results here.
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    let html = '';
    results.forEach(result => {
        const statusClass = result.status === 'inbox' ? 'badge--inbox' :
            result.status === 'spam' ? 'badge--spam' :
                result.status === 'pending' ? 'badge--pending' : 'badge--unknown';

        const statusIcon = result.status === 'inbox' ? 'fa-inbox' :
            result.status === 'spam' ? 'fa-exclamation-triangle' :
                result.status === 'pending' ? 'fa-clock' : 'fa-question';

        const statusText = result.status.charAt(0).toUpperCase() + result.status.slice(1).replace('_', ' ');


        const displayEmail = result.testEmail.length > 25 ? result.testEmail.substring(0, 22) + '...' : result.testEmail;


        const displayIP = result.ipAddress.length > 15 ? result.ipAddress.substring(0, 12) + '...' : result.ipAddress;

        const sentDate = new Date(result.sentAt);
        const dateStr = sentDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
        const timeStr = sentDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

        html += `
            <tr>
                <td>
                    ${result.messageId ? `<div class="cell-sub cell-mono" title="Message-ID: ${result.messageId}">ID: ${result.messageId.substring(0, 20)}...</div>` : ''}
                    <div class="cell-primary" title="${result.testEmail}">${displayEmail}</div>
                    ${result.subject ? `<div class="cell-sub" title="${result.subject}">${result.subject}</div>` : ''}
                </td>
                <td>
                    <code class="cell-mono" title="${result.ipAddress}">${displayIP}</code>
                </td>
                <td class="is-center">
                    <span class="badge ${statusClass}">
                        <i class="fa-solid ${statusIcon}"></i> ${statusText}
                    </span>
                </td>
                <td>
                    <div class="cell-primary">${dateStr}</div>
                    <div class="cell-time">${timeStr}</div>
                    ${result.checkedAt ? `<div class="cell-check">✓ ${new Date(result.checkedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>` : ''}
                </td>
                <td class="is-center">
                    <div class="cell-actions">
                        <button onclick="showEmailDetails('${result.testId}')"
                                class="btn btn--primary btn--sm"
                                title="View Details">
                            <i class="fa-solid fa-eye"></i>
                        </button>
                        <button onclick="deleteTestResult('${result.testId}')"
                                class="btn btn--danger btn--sm"
                                title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}


async function showEmailDetails(testId) {
    try {
        const response = await fetch(`/imap/test-results?limit=100`);
        const data = await response.json();

        if (data.success) {
            const result = data.results.find(r => r.testId === testId);
            if (!result) {
                showError('❌ Test result not found');
                return;
            }

            const popup = document.createElement('div');
            popup.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;

            const statusColor = result.status === 'inbox' ? '#28a745' :
                result.status === 'spam' ? '#dc3545' :
                    result.status === 'pending' ? '#ffc107' : '#6c757d';

            popup.innerHTML = `
                <div style="background: white; padding: 0; border-radius: 8px; max-width: 900px; width: 95%; max-height: 85vh; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3); display: flex; flex-direction: column;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px; border-bottom: 2px solid #dee2e6;">
                        <h3 style="margin: 0; color: #343a40;">
                            <i class="fa-solid fa-envelope-open-text"></i> Email Test Details
                        </h3>
                        <button onclick="this.closest('div[style*=fixed]').remove()" 
                                style="background: #dc3545; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 1em;">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    
                    <!-- Tabs -->
                    <div style="display: flex; border-bottom: 1px solid #dee2e6; background: #f8f9fa; padding: 0 20px;">
                        <button onclick="switchTab(event, 'details-tab')" class="tab-button active" 
                                style="padding: 12px 20px; border: none; background: white; border-bottom: 3px solid #007bff; cursor: pointer; font-weight: 600; color: #007bff; margin-right: 5px;">
                            <i class="fa-solid fa-info-circle"></i> Details
                        </button>
                        <button onclick="switchTab(event, 'raw-tab')" class="tab-button" 
                                style="padding: 12px 20px; border: none; background: transparent; border-bottom: 3px solid transparent; cursor: pointer; font-weight: 600; color: #666;">
                            <i class="fa-solid fa-code"></i> Raw Email
                        </button>
                    </div>
                    
                    <div style="flex: 1; overflow-y: auto; padding: 20px;">
                        <!-- Details Tab -->
                        <div id="details-tab" class="tab-content" style="display: block;">
                            <div style="display: grid; gap: 15px;">
                                ${result.messageId ? `
                                <div>
                                    <strong style="color: #495057;">Message-ID (from IMAP):</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #e7f3ff; border-radius: 4px; border-left: 3px solid #007bff;">
                                        <code style="font-size: 0.85em; word-break: break-all; color: #0056b3;">${result.messageId}</code>
                                    </div>
                                </div>
                                ` : ''}
                                
                                <div>
                                    <strong style="color: #495057;">Test Email:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">${result.testEmail}</div>
                                </div>
                                
                                <div>
                                    <strong style="color: #495057;">IP Address:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                                        <code>${result.ipAddress}</code>
                                    </div>
                                </div>
                                
                                <div>
                                    <strong style="color: #495057;">Status:</strong>
                                    <div style="margin-top: 5px;">
                                        <span style="background: ${statusColor}; color: white; padding: 8px 16px; border-radius: 12px; display: inline-block;">
                                            ${result.status.toUpperCase()}
                                        </span>
                                    </div>
                                </div>
                                
                                ${result.subject ? `
                                <div>
                                    <strong style="color: #495057;">Subject:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">${result.subject}</div>
                                </div>
                                ` : ''}
                                
                                ${result.fromEmail ? `
                                <div>
                                    <strong style="color: #495057;">From:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">${result.fromEmail}</div>
                                </div>
                                ` : ''}
                                
                                <div>
                                    <strong style="color: #495057;">Sent At:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">${new Date(result.sentAt).toLocaleString()}</div>
                                </div>
                                
                                ${result.checkedAt ? `
                                <div>
                                    <strong style="color: #495057;">Checked At:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">${new Date(result.checkedAt).toLocaleString()}</div>
                                </div>
                                ` : ''}
                                
                                ${result.emailDetails?.preview ? `
                                <div>
                                    <strong style="color: #495057;">Preview:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px; font-size: 0.9em; color: #666; font-style: italic;">
                                        ${result.emailDetails.preview}
                                    </div>
                                </div>
                                ` : ''}
                                
                                <div>
                                    <strong style="color: #495057;">Test Type:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                                        <span style="background: ${result.testType === 'auto' ? '#28a745' : '#6c757d'}; color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.85em;">
                                            ${result.testType === 'auto' ? 'Auto' : 'Manual'}
                                        </span>
                                    </div>
                                </div>
                                
                                <div>
                                    <strong style="color: #495057;">Test ID:</strong>
                                    <div style="margin-top: 5px; padding: 10px; background: #f8f9fa; border-radius: 4px; font-family: monospace; font-size: 0.85em; word-break: break-all;">
                                        ${result.testId}
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Raw Email Tab -->
                        <div id="raw-tab" class="tab-content" style="display: none;">
                            ${result.emailDetails?.fullRaw ? `
                                <div>
                                    <strong style="color: #495057; margin-bottom: 10px; display: block;">Full Raw Email:</strong>
                                    <div style="padding: 15px; background: #1e1e1e; border-radius: 4px; overflow-x: auto; max-height: 600px; overflow-y: auto;">
                                        <pre style="margin: 0; color: #d4d4d4; font-size: 0.75em; font-family: 'Courier New', monospace; white-space: pre-wrap; word-wrap: break-word;">${result.emailDetails.fullRaw}</pre>
                                    </div>
                                </div>
                            ` : `
                                <div style="text-align: center; padding: 40px; color: #666;">
                                    <i class="fa-solid fa-inbox" style="font-size: 3em; margin-bottom: 15px; opacity: 0.3;"></i>
                                    <p>Raw email data not available.</p>
                                    <p style="font-size: 0.9em;">This email may not have been checked yet, or raw data was not captured.</p>
                                </div>
                            `}
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(popup);


            window.switchTab = function (event, tabId) {

                const tabContents = popup.querySelectorAll('.tab-content');
                tabContents.forEach(content => content.style.display = 'none');


                const tabButtons = popup.querySelectorAll('.tab-button');
                tabButtons.forEach(button => {
                    button.style.background = 'transparent';
                    button.style.borderBottom = '3px solid transparent';
                    button.style.color = '#666';
                });


                document.getElementById(tabId).style.display = 'block';


                event.currentTarget.style.background = 'white';
                event.currentTarget.style.borderBottom = '3px solid #007bff';
                event.currentTarget.style.color = '#007bff';
            };
        }
    } catch (error) {
        console.error('Error showing email details:', error);
        showError('❌ Failed to load email details');
    }
}


async function deleteTestResult(testId) {
    if (!confirm('Are you sure you want to delete this test result?')) {
        return;
    }

    try {
        const response = await fetch(`/imap/test-results/${testId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showError('✅ Test result deleted successfully');
            await loadTestResults();
        } else {
            showError('❌ Failed to delete test result');
        }
    } catch (error) {
        console.error('Error deleting test result:', error);
        showError('❌ Failed to delete test result: ' + error.message);
    }
}


window.handleAutoImapTest = async function (testRecipients, smtpHost, subject, fromEmail, backendTestIds) {
    if (!autoImapTestEnabled) return;

    if (!backendTestIds || backendTestIds.length === 0) {
        console.error('No test IDs received from backend');
        return;
    }

    try {

        const matchedAccounts = [];
        for (const recipient of testRecipients) {
            const account = testEmailAccounts.find(acc => acc.email === recipient);
            if (account) {
                matchedAccounts.push(account.email);
            }
        }


        const missingAccounts = testRecipients.filter(r => !matchedAccounts.includes(r));
        if (missingAccounts.length > 0) {
            showError(`⚠️ Please add test email accounts for: ${missingAccounts.join(', ')}`);

        }


        selectedEmails = [...matchedAccounts];
        renderEmailList();
        updateCurrentEmailDisplay();

        showError(`✅ Test emails logged (IDs: ${backendTestIds.length}). Auto-checking IMAP in 10 seconds...`);


        await loadTestResults();


        const checkBothBtn = document.getElementById('check-both');
        if (checkBothBtn) {
            checkBothBtn.disabled = true;
            checkBothBtn.style.opacity = '0.7';
            checkBothBtn.style.cursor = 'not-allowed';
            checkBothBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Auto-Checking...';
        }


        setTimeout(async () => {

            await checkAutoTestStatus(backendTestIds);

        }, 10000);

    } catch (error) {
        console.error('Error handling auto IMAP test:', error);
        showError('❌ Failed to setup auto IMAP test');


        const checkBothBtn = document.getElementById('check-both');
        if (checkBothBtn) {
            checkBothBtn.disabled = false;
            checkBothBtn.style.opacity = '1';
            checkBothBtn.style.cursor = 'pointer';
            checkBothBtn.innerHTML = '<i class="fa-solid fa-sync-alt"></i> Check Manually';
        }
    }
};


async function checkAutoTestStatus(testIds) {
    if (selectedEmails.length === 0) {
        showError('⚠️ No test email accounts selected for checking');
        return;
    }

    if (!imapCredentials.host) {
        showError('⚠️ IMAP credentials not configured. Please configure IMAP settings first.');
        return;
    }

    try {
        showError('⏳ Auto-checking IMAP for test emails...');

        await loadTestResults();

        let totalChecked = 0;
        let totalErrors = 0;
        const errorMessages = [];

        for (const email of selectedEmails) {
            const account = testEmailAccounts.find(acc => acc.email === email);

            if (!account) {
                errorMessages.push(`Account ${email} not found`);
                totalErrors++;
                continue;
            }

            const pwd = await getAccountPassword(account._id);
            if (!pwd) {
                errorMessages.push(`Could not retrieve app password for ${email}`);
                totalErrors++;
                continue;
            }

            try {
                const response = await fetch('/imap/check-auto-test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        host: imapCredentials.host,
                        port: imapCredentials.port,
                        ssl: imapCredentials.ssl,
                        email: account.email,
                        password: pwd,
                        testIds
                    })
                });

                const data = await response.json();

                if (!response.ok) {
                    if (data.error && data.error.includes('AUTHENTICATIONFAILED')) {
                        errorMessages.push(`Authentication failed for ${email}. Please check app password.`);
                    } else {
                        errorMessages.push(`Error checking ${email}: ${data.error || 'Unknown error'}`);
                    }
                    totalErrors++;
                } else {
                    totalChecked += (data.results || []).length;
                }

                await loadTestResults();
            } catch (error) {
                errorMessages.push(`Network error for ${email}: ${error.message}`);
                totalErrors++;
            }
        }


        await loadTestResults();


        if (totalErrors === 0) {
            showError(`✅ Auto IMAP check completed: Found and updated ${totalChecked} test email(s)`);
        } else {
            let errorMsg = `⚠️ Auto IMAP check completed with ${totalErrors} error(s)`;
            if (totalChecked > 0) {
                errorMsg += `: Found ${totalChecked} test email(s)`;
            }
            if (errorMessages.length > 0) {
                errorMsg += `\n${errorMessages.join('\n')}`;
            }
            showError(errorMsg);
        }

    } catch (error) {
        console.error('Error checking auto test status:', error);
        showError('❌ Failed to check auto test status: ' + error.message);
    } finally {
        const checkBothBtn = document.getElementById('check-both');
        if (checkBothBtn) {
            checkBothBtn.disabled = false;
            checkBothBtn.style.opacity = '1';
            checkBothBtn.style.cursor = 'pointer';
            checkBothBtn.innerHTML = '<i class="fa-solid fa-sync-alt"></i> Check Manually';
        }
    }
}
