let sessionId = null;
let lastLimit = 0;
let lastBatchCount = 0;
let isSending = false;


let currentLogs = [];
let currentPage = 1;
let totalPages = 1;
let logsPerPage = 10;


let currentFiles = [];
let currentFilePage = 1;
let totalFilePages = 1;
let filesPerPage = 10;


async function loadFiles(page = 1) {
  try {
    const cacheBuster = Date.now();
    const response = await fetch(`/files?page=${page}&limit=${filesPerPage}&sortBy=uploadDate&sortOrder=desc&_=${cacheBuster}`);
    if (!response.ok) {
      throw new Error('Failed to load files');
    }

    const data = await response.json();
    currentFiles = data.files;
    currentFilePage = data.pagination.page;
    totalFilePages = data.pagination.totalPages;

    return data;
  } catch (error) {
    console.error('Error loading files:', error);
    showError('Failed to load files: ' + error.message);
    return null;
  }
}


async function loadLogs(page = 1, retries = 3) {
  try {
    const cacheBuster = Date.now();
    const response = await fetch(`/logs?page=${page}&limit=${logsPerPage}&sortBy=createdAt&sortOrder=desc&_=${cacheBuster}`);
    
    if (!response.ok) {

       throw new Error(`Failed to load logs (HTTP ${response.status})`);
    }

    const data = await response.json();
    currentLogs = data.logs;
    currentPage = data.pagination.page;
    totalPages = data.pagination.totalPages;

    updateLogDisplay();
    return data;
  } catch (error) {
    console.warn(`Attempt to load logs failed: ${error.message}. Retries left: ${retries}`);
    
    if (retries > 0) {

       const delay = (4 - retries) * 1000;
       await new Promise(resolve => setTimeout(resolve, delay));
       return loadLogs(page, retries - 1);
    }
    
    console.error('Final attempt to load logs failed:', error);

    if (!isPolling) {
       showError('Failed to load logs: ' + error.message);
    }
    return null;
  }
}


function updateLogDisplay() {
  const logCount = currentLogs.length;
  const logBtn = document.getElementById('Download-log');
  const deleteBtn = document.getElementById('delete-log');

  if (logBtn) {
    logBtn.innerHTML = `<i class="fa-solid fa-download"></i> Download Log (${logCount})`;
    logBtn.disabled = logCount === 0;
  }

  if (deleteBtn) {
    deleteBtn.innerHTML = `<i class="fa-solid fa-trash"></i> Delete Log (${logCount})`;
    deleteBtn.disabled = logCount === 0;
  }
}



/**
 * Connection details are remembered for convenience. The password is
 * deliberately excluded: localStorage persists indefinitely and is readable by
 * any script on the origin, so a single XSS would hand over the SMTP
 * credential. It has to be re-entered per session.
 */
const smtpFields = [
  { id: 'smtp-host', key: 'smtpHost' },
  { id: 'smtp-port', key: 'smtpPort' },
  { id: 'smtp-user', key: 'smtpUser' }
];

const LEGACY_SMTP_PASS_KEY = 'smtpPass';

function loadSmtpCreds() {
  // Remove any password persisted by an earlier version of this file.
  localStorage.removeItem(LEGACY_SMTP_PASS_KEY);

  smtpFields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el && localStorage.getItem(f.key)) {
      el.value = localStorage.getItem(f.key);
    }
  });
}

function saveSmtpCreds() {
  smtpFields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) {
      localStorage.setItem(f.key, el.value);
    }
  });
}

window.addEventListener('DOMContentLoaded', loadSmtpCreds);

const emailForm = document.getElementById('email-form');
if (emailForm) {
  emailForm.addEventListener('submit', function (e) {
    e.preventDefault();
    saveSmtpCreds();


    if (bulkRadio && bulkRadio.checked) {
      const fileIdsField = document.getElementById('file-ids');
      const fileIds = fileIdsField ? fileIdsField.value.trim() : '';

      if (!fileIds) {
        showError('❌ File IDs are mandatory for bulk campaigns. Please add file IDs to proceed.');
        return;
      }

      const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);
      if (fileIdArray.length === 0) {
        showError('❌ Please provide at least one valid File ID for bulk campaigns.');
        return;
      }
    }

    const formData = new FormData(emailForm);

    if (testRadio && testRadio.checked) {

      sessionId = `test-${Date.now()}`;
      formData.append('sessionId', sessionId);
      console.log('Added test sessionId to form:', sessionId);
    } else if (bulkRadio && bulkRadio.checked) {
      const fileIdsField = document.getElementById('file-ids');
      const fileIds = fileIdsField ? fileIdsField.value.trim() : '';
      if (fileIds) {
        const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);
        if (fileIdArray.length > 0) {
 
          sessionId = fileIdArray[0];
          formData.append('sessionId', sessionId);
          console.log('Added bulk sessionId to form:', sessionId);
        } else {
          console.log('No valid file IDs found');
        }
      } else {
        console.log('No file IDs provided');
      }
    }

    lastLimit = parseInt(formData.get('limit')) || 0;
    isSending = true;


    const formDataObj = Object.fromEntries(formData.entries());
    console.log('Sending form data:', formDataObj);

    fetch('/send-email', {
      method: 'POST',
      body: new URLSearchParams([...formData])
    })
      .then(async res => {
        let data;
        try { data = await res.json(); } catch { data = {}; }
        if (!res.ok) {
          showError(data.error || 'Send failed.');
          return;
        }
        if (data.status === 'enqueued') {
          showError('');
          lastBatchCount = data.batchCount;

          if (testRadio && testRadio.checked) {
          } else if (bulkRadio && bulkRadio.checked) {
            const currentPending = parseInt(document.getElementById('bulk-pending').textContent) || 0;
            const newPending = Math.max(0, currentPending - lastBatchCount);

            document.getElementById('bulk-queue').textContent = lastBatchCount;
            document.getElementById('bulk-total-sending').textContent = lastLimit;
            document.getElementById('bulk-pending').textContent = newPending;
          }

          startStatusPolling();
          loadLogs();
          if (testRadio && testRadio.checked) {
            const testRecpField = document.getElementById('test-recp');
            const testRecipients = testRecpField ? testRecpField.value.trim() : '';
            showError(`✅ Test campaign started! ${lastBatchCount} test emails moved from pending to queue. Recipients: ${testRecipients}`);

            const recipients = testRecipients.split(/[,\n]/).map(e => e.trim()).filter(e => e);
            const smtpHost = document.getElementById('smtp-host')?.value || '';
            const subject = document.getElementById('subject')?.value || '';
            const fromEmail = document.getElementById('smtp-from-email')?.value || '';

            if (window.handleAutoImapTest && typeof window.handleAutoImapTest === 'function' && data.testIds && data.testIds.length > 0) {

              window.handleAutoImapTest(recipients, smtpHost, subject, fromEmail, data.testIds);
            } else if (!window.handleAutoImapTest && data.testIds && data.testIds.length > 0) {

              console.log(`✅ Saved ${data.testIds.length} test records on backend`);
            }
          } else if (bulkRadio && bulkRadio.checked) {

            const fileIdsField = document.getElementById('file-ids');
            if (fileIdsField && fileIdsField.value.trim()) {
              showError(`✅ Bulk campaign started! ${lastBatchCount} emails moved from pending to queue. File IDs: ${fileIdsField.value.trim()}`);
            }
          }
        } else if (data.error) {
          showError(data.error);
        }
      })
      .catch(err => showError('Send failed: ' + (err.message || err)));
  });
}


let statusTimeout = null;
let isPolling = false;

function startStatusPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('Starting status polling with sessionId:', sessionId);
  
  if (statusTimeout) clearTimeout(statusTimeout);
  
  if (!sessionId) {
    console.log('No sessionId available for status polling');
    isPolling = false;
    return;
  }

  const runPoll = async () => {
    if (!isPolling || document.hidden) {

       statusTimeout = setTimeout(runPoll, 2000);
       return;
    }
    
    await pollStatus();
    
    let pollInterval = 2000;

    if (isSending) {
      pollInterval = 1000;
    }
    
    statusTimeout = setTimeout(runPoll, pollInterval);
  };
  
  runPoll();
  

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isPolling) {

       clearTimeout(statusTimeout);
       runPoll();
    }
  });
}

function stopStatusPolling() {
  isPolling = false;
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }
}

async function pollStatus() {
  if (!sessionId) return;
  
  try {
    const res = await fetch(`/status?sessionId=${sessionId}`);
    if (!res.ok) {
       console.error('Status fetch failed');
       return;
    }
    
    const data = await res.json();
    if (data.total !== undefined) {

      const isTestMode = testRadio && testRadio.checked;
      const prefix = isTestMode ? 'test-' : 'bulk-';

      if (isTestMode) {
        document.getElementById(prefix + 'sent').textContent = data.sent || 0;
        document.getElementById(prefix + 'failed').textContent = data.failed || 0;
      } else {

        document.getElementById(prefix + 'total').textContent = data.total;

        const queueCount = data.sending || 0;
        const queueEl = document.getElementById(prefix + 'queue');
        if (queueEl) queueEl.textContent = queueCount;
        

        const totalSendingEl = document.getElementById(prefix + 'total-sending');
        if (totalSendingEl) totalSendingEl.textContent = lastLimit;
        

        const pending = Math.max(0, data.total - (data.sent || 0) - (data.failed || 0));
        const pendingEl = document.getElementById(prefix + 'pending');
        if (pendingEl) pendingEl.textContent = pending;
        

        document.getElementById(prefix + 'sent').textContent = data.sent || 0;

        document.getElementById(prefix + 'failed').textContent = data.failed || 0;
      }

      window.currentSessionId = sessionId;


      if ((data.sent + data.failed) >= (data.sentIndex || 0)) {
        isSending = false;

        if (data.sent + data.failed >= data.total) {
           stopStatusPolling();
        }
      }
      
      if (data.lastError) {
        showError(data.lastError);
      } else {

      }
    }
  } catch (err) {
    console.error('Status fetch failed:', err);
  }
}


function showError(msg) {
  const errBox = document.getElementById('errors');
  if (errBox) errBox.textContent = msg;
}


const previewBtn = document.getElementById('preview-html');
if (previewBtn) {
  previewBtn.addEventListener('click', function () {
    const msg = document.getElementById('message').value;
    const isHtml = document.getElementById('html').checked;
    if (isHtml) {
      showPopup('Preview', msg);
    } else {
      showPopup('Preview', `<pre style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(msg)}</pre>`);
    }
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showPopup(title, html) {

  let oldPopup = document.getElementById('custom-popup');
  if (oldPopup) oldPopup.remove();


  const popup = document.createElement('div');
  popup.id = 'custom-popup';
  popup.style.position = 'fixed';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  popup.style.background = '#fff';
  popup.style.zIndex = 10000;
  popup.style.border = '1px solid #333';
  popup.style.boxShadow = '0 2px 10px #0002';
  popup.style.boxSizing = 'border-box';
  popup.style.overflowY = 'auto';
  popup.style.maxHeight = '90vh';
  popup.style.minWidth = '280px';
  popup.style.width = '90vw';
  popup.style.maxWidth = title === 'Preview' ? '900px' : '95vw';
  popup.style.padding = '2.5em 3em 1em 1em'; 


  if (window.innerWidth < 400) {
    popup.style.padding = '2.5em 2em 0.5em 0.5em';
    popup.style.minWidth = '0';
  }


  const closeBtn = document.createElement('button');
  closeBtn.id = 'close-popup';
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '10px';
  closeBtn.style.right = '10px';
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.fontSize = '1.5em';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = '#333';
  closeBtn.onclick = () => {
    popup.remove();

    stopLogPopupAutoRefresh();
  };
  popup.appendChild(closeBtn);


  const h3 = document.createElement('h3');
  h3.textContent = title;
  h3.style.marginTop = '0';
  h3.style.marginRight = '0';
  popup.appendChild(h3);


  const contentDiv = document.createElement('div');
  contentDiv.id = 'popup-content';

  if (title === 'Preview') {
    contentDiv.style.maxWidth = '900px';
    contentDiv.style.margin = '0 auto';
    contentDiv.style.background = '#f9f9f9';
    contentDiv.style.padding = '1em';
    contentDiv.style.borderRadius = '8px';
    contentDiv.style.boxShadow = '0 1px 4px #0001';
    contentDiv.style.overflow = 'auto';
    contentDiv.style.display = 'block';
    contentDiv.innerHTML = html;
  } else {
    contentDiv.innerHTML = html;
  }

  popup.appendChild(contentDiv);
  document.body.appendChild(popup);
  popup.style.display = 'block';
}


const testRadio = document.getElementById('test');
const bulkRadio = document.getElementById('bulk');
const testRecpTextarea = document.getElementById('test-recp');

function updateModeUI() {
  const testStatusBox = document.getElementById('test-status');
  const bulkStatusBox = document.getElementById('bulk-status');

  if (testRadio && testRadio.checked) {
    if (testRecpTextarea) testRecpTextarea.disabled = false;

    if (testStatusBox) testStatusBox.style.display = 'block';
    if (bulkStatusBox) bulkStatusBox.style.display = 'none';

    updateLiveStatusForTestMode();
  } else if (bulkRadio && bulkRadio.checked) {
    if (testRecpTextarea) testRecpTextarea.disabled = true;

    if (testStatusBox) testStatusBox.style.display = 'none';
    if (bulkStatusBox) bulkStatusBox.style.display = 'block';


    updateLiveStatusFromFileIds();
  }
}
if (testRadio) testRadio.addEventListener('change', updateModeUI);
if (bulkRadio) bulkRadio.addEventListener('change', updateModeUI);
window.addEventListener('DOMContentLoaded', function () {
  updateModeUI();

  if (!testRadio.checked && !bulkRadio.checked) {
    testRadio.checked = true;
    updateModeUI();
  }
});

const refreshTestStatsBtn = document.getElementById('refresh-test-stats');
if (refreshTestStatsBtn) {
  refreshTestStatsBtn.addEventListener('click', refreshTestModeStats);
}

const infoBtn = document.getElementById('info');
if (infoBtn) {
  infoBtn.addEventListener('click', function () {
    showPopup('Info', `
      <b>Bulk Email Sender - How to Use</b><br><br>
      <ul>
        <li><b>1. Upload Recipients:</b> Upload a file (.csv, .txt, .xlsx, .xls, .json) containing email addresses. Only valid emails are counted. The total is shown in the status panel. <b>If you select Test mode, file upload is disabled.</b></li>
        <li><b>2. Configure SMTP:</b> Enter your SMTP server details (host, port, user, password). This is required to send emails.</li>
        <li><b>3. Email Configuration:</b>
          <ul>
            <li><b>Test or Bulk:</b> Choose <b>Test</b> to send to test recipients (entered below), or <b>Bulk</b> to use the uploaded file. <b>Switching between Test and Bulk is allowed at any time. Bulk progress is preserved if you pause to send a test email.</b></li>
            <li><b>Test Recipients:</b> (for Test mode) Enter one or more email addresses, separated by commas. <b>This field is disabled in Bulk mode.</b></li>
            <li><b>Limit:</b> Set how many emails to send in one batch. For example, if you upload 100 emails and set limit to 25, only the first 25 will be sent. Next batch will start from the next email.</li>
            <li><b>From Name/Email:</b> Set the sender's name and email address.</li>
            <li><b>Subject:</b> Enter the email subject.</li>
            <li><b>File IDs:</b> (Mandatory for Bulk) Specify which uploaded files to use for recipients. You can specify multiple file IDs separated by commas. File IDs are required for bulk campaigns.</li>
            <li><b>Custom Headers:</b> (Optional) Add custom email headers in format "Header-Name: value". One header per line. Example:
              <ul>
                <li>X-Campaign-ID: summer2024</li>
                <li>X-Priority: high</li>
                <li>List-Unsubscribe: &lt;mailto:unsubscribe@example.com&gt;</li>
              </ul>
            </li>
            <li><b>Message Type:</b> Choose <b>Plain</b> for plain text or <b>HTML</b> for HTML emails.</li>
            <li><b>Message/HTML:</b> Enter your email content. Use the Preview button to see how it will look.</li>
          </ul>
        </li>
                    <li><b>4. Send Email:</b> Click <b>Send Email</b> to start sending. The system will send emails in batches as per your limit. No duplicate emails will be sent. <b>File IDs are mandatory for bulk campaigns.</b></li>
        <li><b>5. Live Status:</b> Separate status boxes for each mode:
          <ul>
            <li><b>Test Mode Status Box:</b> Shows statistics for test recipients entered in the form (green theme)</li>
            <li><b>Bulk Mode Status Box:</b> Shows statistics for emails from selected file IDs (blue theme)</li>
            <li><b>Mode Switching:</b> Only the relevant status box is shown based on selected mode</li>
            <li><b>Total:</b> Total emails (test recipients or valid emails from files)</li>
            <li><b>Queue:</b> Emails currently being processed</li>
            <li><b>Limit:</b> The batch size you set</li>
            <li><b>Live Sending:</b> Number of emails being sent in the current batch</li>
            <li><b>Pending:</b> Emails left to send (decreases as emails are sent)</li>
            <li><b>Total Sent:</b> Emails sent successfully</li>
            <li><b>Total Failed:</b> Emails that failed to send</li>
          </ul>
        </li>
        <li><b>6. File Management:</b> 
          <ul>
            <li><b>File Storage:</b> All uploaded recipient files are stored on the server</li>
            <li><b>File Statistics:</b> Track total, valid, invalid, sent, failed, and pending emails for each file</li>
            <li><b>File IDs:</b> Each uploaded file gets a unique ID that you can copy and use in campaigns</li>
            <li><b>Download Options:</b> Download original file, sent emails, failed emails, or pending emails</li>
            <li><b>File Management:</b> Click "View Files" to see all uploaded files with detailed statistics</li>
            <li><b>Add to Form:</b> Use "Add to Form" button to easily add file IDs to your campaign</li>
            <li><b>Log Preservation:</b> Campaign logs are preserved even when files are deleted</li>
          </ul>
        </li>
        <li><b>7. Database Logs:</b> 
          <ul>
            <li><b>MongoDB Storage:</b> All email logs are automatically saved in MongoDB database</li>
            <li><b>Persistent Logs:</b> Logs remain available even after server restarts</li>
            <li><b>Separate Test Logs:</b> Test mode creates separate logs with "test-" prefix</li>
                    <li><b>Log Management:</b> Click "Download Log" to see all available logs separated by mode (Test/Bulk) and choose which to download</li>
            <li><b>Log Count:</b> Button shows number of available logs (e.g., "Download Log (5)")</li>
          </ul>
        </li>
        <li><b>8. Delete Log:</b>
          <ul>
                    <li><b>Individual Delete:</b> Delete specific session logs directly</li>
        <li><b>Delete All:</b> Clear all stored logs at once</li>
        <li><b>Separated Sections:</b> Test mode and bulk mode logs are shown in separate sections</li>
            <li><b>Permanent Action:</b> Deleted logs cannot be recovered - download important data first!</li>
            <li><b>Log Count:</b> Button shows number of available logs (e.g., "Delete Log (5)")</li>
          </ul>
        </li>
        <li><b>9. Error Handling:</b> All errors (upload, send, status, log) are shown in the error box below the status panel. No page reloads are needed.</li>
        <li><b>10. Info & Preview:</b> Use the Info button (this popup) for help, and the Preview button to see your message before sending.</li>
      </ul>
      <b>🆕 New Features:</b><br>
      - <b>Mandatory File IDs:</b> File IDs are now required for bulk campaigns - upload files first, then add their IDs to campaigns<br>
      - <b>Live Status Updates:</b> Live status updates automatically when file IDs are added or removed from the form<br>
      - <b>Separate Status Boxes:</b> Test and bulk modes have completely separate live status boxes<br>
      - <b>File ID System:</b> Each uploaded file gets a unique ID that can be copied and reused in campaigns<br>
      - <b>Multi-File Campaigns:</b> Combine recipients from multiple uploaded files in a single campaign<br>
      - <b>File Storage System:</b> All uploaded recipient files are stored on the server with detailed tracking<br>
      - <b>Advanced File Management:</b> View all uploaded files with comprehensive statistics and download options<br>
      - <b>Multiple Download Types:</b> Download original files, sent emails, failed emails, or pending emails<br>
      - <b>MongoDB Database:</b> All email logs are automatically saved in MongoDB database<br>
      - <b>Persistent Storage:</b> Logs persist across server restarts and are stored securely<br>
      - <b>Advanced Log Management:</b> View, download, and delete logs with pagination<br>
      - <b>Direct Delete:</b> Delete operations work directly without confirmations<br>
      - <b>Real-time Updates:</b> Logs are updated in real-time as emails are sent<br>
      - <b>Log Preservation:</b> Campaign logs are preserved even when recipient files are deleted<br>
      - <b>Separate Test Logs:</b> Test mode creates separate logs with "test-" prefix for easy identification<br><br>
      <b>Tips:</b><br>
      - Use batching (limit) to avoid SMTP rate limits.<br>
      - Always check the status and error box for feedback.<br>
      - <b>Download important logs before deleting them!</b><br>
      - For best results, use a reliable SMTP server.<br>
      - Logs are stored in MongoDB database - they won't be lost when you restart the server.<br><br><br>
    `);
  });
}


const logBtn = document.getElementById('Download-log');
if (logBtn) {
  logBtn.addEventListener('click', function () {
    showLogSelectionPopup();
  });
}


async function updateLiveStatusForTestMode() {
  const testRecpField = document.getElementById('test-recp');
  if (!testRecpField) return;

  const testRecipients = testRecpField.value.trim();
  if (!testRecipients) {

    document.getElementById('test-sent').textContent = '0';
    document.getElementById('test-failed').textContent = '0';

    sessionId = null;
    return;
  }

  try {

    const recipientArray = testRecipients.split(',').map(email => email.trim()).filter(email => email);

    if (recipientArray.length === 0) {
      showError('⚠️ No valid test recipients found');
      return;
    }


    document.getElementById('test-sent').textContent = '0'; 
    document.getElementById('test-failed').textContent = '0'; 


    sessionId = null;

    showError(`✅ Test mode live status updated! Total test recipients: ${recipientArray.length}`);

  } catch (error) {
    console.error('Error updating test mode live status:', error);
    showError('❌ Failed to update test mode live status: ' + error.message);
  }
}

async function refreshTestModeStats() {
  try {

    if (!sessionId || !sessionId.startsWith('test-')) {
      showError('⚠️ No active test campaign to refresh');
      return;
    }


    const response = await fetch(`/status?sessionId=${sessionId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch current test campaign status');
    }

    const data = await response.json();

    document.getElementById('test-sent').textContent = data.sent || 0;
    document.getElementById('test-failed').textContent = data.failed || 0;

    showError(`✅ Test mode stats refreshed! Current campaign - Sent: ${data.sent || 0}, Failed: ${data.failed || 0}`);

  } catch (error) {
    console.error('Error refreshing test mode stats:', error);
    showError('❌ Failed to refresh test mode stats: ' + error.message);
  }
}


async function updateLiveStatusFromFileIds() {
  const fileIdsField = document.getElementById('file-ids');
  if (!fileIdsField) return;

  const fileIds = fileIdsField.value.trim();
  if (!fileIds) {
 
    document.getElementById('bulk-total').textContent = '0';
    document.getElementById('bulk-queue').textContent = '0';
    document.getElementById('bulk-total-sending').textContent = '0';
    document.getElementById('bulk-pending').textContent = '0';
    document.getElementById('bulk-sent').textContent = '0';
    document.getElementById('bulk-failed').textContent = '0';


    sessionId = null;
    return;
  }

  try {

    const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);


    const response = await fetch('/files-stats');
    if (!response.ok) {
      throw new Error('Failed to fetch file statistics');
    }

    const stats = await response.json();

 
    const filesResponse = await fetch('/files?limit=1000'); 
    if (!filesResponse.ok) {
      throw new Error('Failed to fetch files');
    }

    const filesData = await filesResponse.json();
    const selectedFiles = filesData.files.filter(file => fileIdArray.includes(file.sessionId));

    if (selectedFiles.length === 0) {
      showError('⚠️ No valid files found with the specified File IDs');
      return;
    }


    const totalValidEmails = selectedFiles.reduce((sum, file) => sum + file.validEmails, 0);
    const totalSentEmails = selectedFiles.reduce((sum, file) => sum + file.sentEmails, 0);
    const totalFailedEmails = selectedFiles.reduce((sum, file) => sum + file.failedEmails, 0);
    const totalPendingEmails = selectedFiles.reduce((sum, file) => sum + file.pendingEmails, 0);

 
    document.getElementById('bulk-total').textContent = totalValidEmails;
    document.getElementById('bulk-queue').textContent = '0'; 
    document.getElementById('bulk-total-sending').textContent = '0'; 
    document.getElementById('bulk-pending').textContent = totalPendingEmails; 
    document.getElementById('bulk-sent').textContent = totalSentEmails;
    document.getElementById('bulk-failed').textContent = totalFailedEmails;


    window.selectedFileIds = fileIdArray;


    if (fileIdArray.length > 0) {
      sessionId = fileIdArray[0];
    }

    showError(`✅ Live status updated! Files: ${selectedFiles.length}, Total: ${totalValidEmails}, Sent: ${totalSentEmails}, Failed: ${totalFailedEmails}, Pending: ${totalPendingEmails}`);

  } catch (error) {
    console.error('Error updating live status:', error);
    showError('❌ Failed to update live status: ' + error.message);
  }
}





async function showLogSelectionPopup() {
  try {

    if (currentLogs.length === 0) {
      const data = await loadLogs();
      if (!data) return;
    }

    if (currentLogs.length === 0) {
      showError('No logs available in database.');
      return;
    }

    let popupContent = '<div style="margin-bottom: 15px;"><b>Select a log to download:</b></div>';


    popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
    popupContent += '<button onclick="refreshLogPopup()" style="background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">';
    popupContent += '<i class="fa-solid fa-sync-alt"></i> Refresh Stats';
    popupContent += '</button>';
    popupContent += '</div>';

    if (totalPages > 1) {
      popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
      if (currentPage > 1) {
        popupContent += `<button onclick="changeLogPage(${currentPage - 1})" style="margin-right: 10px; padding: 5px 10px;">Previous</button>`;
      }
      popupContent += `<span>Page ${currentPage} of ${totalPages}</span>`;
      if (currentPage < totalPages) {
        popupContent += `<button onclick="changeLogPage(${currentPage + 1})" style="margin-left: 10px; padding: 5px 10px;">Next</button>`;
      }
      popupContent += '</div>';
    }

    const testLogs = currentLogs.filter(log => log.sessionId.startsWith('test-'));
    const bulkLogs = currentLogs.filter(log => !log.sessionId.startsWith('test-'));


    popupContent += '<div style="display: flex; gap: 20px; margin-bottom: 20px;">';

    popupContent += '<div style="flex: 1;">';
    if (testLogs.length > 0) {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs</h3>';
      popupContent += '</div>';

      testLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; cursor: pointer; background: #f8fff9;" 
               onclick="downloadSelectedLog('${log.sessionId}')">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
              Subject: ${log.subject || 'N/A'}
            </div>
            <div style="font-size: 0.9em;">
              Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fff9; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No test logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '<div style="flex: 1;">';
    if (bulkLogs.length > 0) {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs</h3>';
      popupContent += '</div>';

      bulkLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; cursor: pointer; background: #f8fbff;" 
               onclick="downloadSelectedLog('${log.sessionId}')">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
              Subject: ${log.subject || 'N/A'}
            </div>
            <div style="font-size: 0.9em;">
              Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fbff; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No bulk logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '</div>';

    popupContent += '</div>';

    showPopup('Download Log', popupContent);

    startLogPopupAutoRefresh();
  } catch (error) {
    showError('Failed to load logs: ' + error.message);
  }
}

async function changeLogPage(page) {
  await loadLogs(page);
  showLogSelectionPopup();
}

async function refreshLogPopup() {
  try {
    await loadLogs(currentPage);
    showLogSelectionPopup();
  } catch (error) {
    console.error('Error refreshing log popup:', error);
  }
}

let logPopupRefreshInterval = null;

function startLogPopupAutoRefresh() {
  if (logPopupRefreshInterval) {
    clearTimeout(logPopupRefreshInterval);
  }
  
  const runRefresh = async () => {
    if (!logPopupRefreshInterval) return; 
    
    if (document.hidden) {
      logPopupRefreshInterval = setTimeout(runRefresh, 5000);
      return;
    }

    const popup = document.getElementById('custom-popup');
    if (popup && popup.querySelector('div[style*="Select a log to download"]')) {
      await refreshLogPopup();

      logPopupRefreshInterval = setTimeout(runRefresh, 10000);
    } else {
      stopLogPopupAutoRefresh();
    }
  };
  
  logPopupRefreshInterval = setTimeout(runRefresh, 5000);
}

function stopLogPopupAutoRefresh() {
  if (logPopupRefreshInterval) {
    clearTimeout(logPopupRefreshInterval);
    logPopupRefreshInterval = null;
  }
}


async function downloadSelectedLog(sessionId) {
  try {
    const response = await fetch(`/logs/${sessionId}/download`);
    if (!response.ok) {
      throw new Error('Failed to download log');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `emaillog-${sessionId}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    showError('');


    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Log download failed: ' + error.message);
  }
}


const deleteBtn = document.getElementById('delete-log');
if (deleteBtn) {
  deleteBtn.addEventListener('click', function () {
    showDeleteLogPopup();
  });
}


async function showDeleteLogPopup() {
  try {

    if (currentLogs.length === 0) {
      const data = await loadLogs();
      if (!data) return;
    }

    let popupContent = '<div style="margin-bottom: 15px;"><b>Select logs to delete:</b></div>';

    if (totalPages > 1) {
      popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
      if (currentPage > 1) {
        popupContent += `<button onclick="changeDeletePage(${currentPage - 1})" style="margin-right: 10px; padding: 5px 10px;">Previous</button>`;
      }
      popupContent += `<span>Page ${currentPage} of ${totalPages}</span>`;
      if (currentPage < totalPages) {
        popupContent += `<button onclick="changeDeletePage(${currentPage + 1})" style="margin-left: 10px; padding: 5px 10px;">Next</button>`;
      }
      popupContent += '</div>';
    }

    const testLogs = currentLogs.filter(log => log.sessionId.startsWith('test-'));
    const bulkLogs = currentLogs.filter(log => !log.sessionId.startsWith('test-'));

    popupContent += '<div style="display: flex; gap: 20px; margin-bottom: 20px;">';

    popupContent += '<div style="flex: 1;">';
    if (testLogs.length > 0) {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs</h3>';
      popupContent += '</div>';

      testLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; background: #f8fff9;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div style="flex: 1;">
                <div style="font-weight: bold;">Session: ${log.sessionId}</div>
                <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
                <div style="font-size: 0.9em;">
                  Subject: ${log.subject || 'N/A'}
                </div>
                <div style="font-size: 0.9em;">
                  Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
                </div>
                <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
              </div>
              <button onclick="deleteSelectedLog('${log.sessionId}')" 
                      style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-left: 10px;">
                <i class="fa-solid fa-trash"></i> Delete
              </button>
            </div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fff9; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No test logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '<div style="flex: 1;">';
    if (bulkLogs.length > 0) {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs</h3>';
      popupContent += '</div>';

      bulkLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; background: #f8fbff;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="flex: 1;">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
                  Subject: ${log.subject || 'N/A'}
                </div>
                <div style="font-size: 0.9em;">
                  Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
          <button onclick="deleteSelectedLog('${log.sessionId}')" 
                  style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-left: 10px;">
            <i class="fa-solid fa-trash"></i> Delete
          </button>
        </div>
      </div>
    `;
      });
    } else {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fbff; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No bulk logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '</div>';

    popupContent += '</div>';
    popupContent += '<div style="margin-top: 15px; text-align: center;">';
    popupContent += '<button onclick="deleteAllLogs()" style="background: #dc3545; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">';
    popupContent += '<i class="fa-solid fa-trash"></i> Delete All Logs';
    popupContent += '</button>';
    popupContent += '</div>';

    showPopup('Delete Logs', popupContent);
  } catch (error) {
    showError('Failed to load logs: ' + error.message);
  }
}


async function changeDeletePage(page) {
  await loadLogs(page);
  showDeleteLogPopup();
}


async function deleteSelectedLog(sessionId) {
  try {
    const response = await fetch(`/logs/${sessionId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to delete log');
    }

    showError(`✅ Log for session ${sessionId} deleted successfully.`);


    await loadLogs(currentPage);


    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Delete failed: ' + error.message);
  }
}


async function deleteAllLogs() {
  try {
    const response = await fetch('/logs', {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to delete all logs');
    }

    const result = await response.json();
    showError(`✅ ${result.message}`);


    await loadLogs(1);


    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Delete all failed: ' + error.message);
  }
}


window.addEventListener('DOMContentLoaded', function () {
  const passInput = document.getElementById('smtp-pass');
  const toggleBtn = document.getElementById('toggle-smtp-pass');
  const eyeIcon = document.getElementById('smtp-pass-eye');
  if (passInput && toggleBtn && eyeIcon) {
    toggleBtn.addEventListener('click', function () {
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
  }


  const fileIdsField = document.getElementById('file-ids');
  if (fileIdsField) {

    let debounceTimer;
    fileIdsField.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateLiveStatusFromFileIds();
      }, 500); 
    });

    fileIdsField.addEventListener('blur', function () {
      clearTimeout(debounceTimer);
      updateLiveStatusFromFileIds();
    });
  }


  const testRecpField = document.getElementById('test-recp');
  if (testRecpField) {

    let testDebounceTimer;
    testRecpField.addEventListener('input', function () {
      clearTimeout(testDebounceTimer);
      testDebounceTimer = setTimeout(() => {
        updateLiveStatusForTestMode();
      }, 500); 
    });


    testRecpField.addEventListener('blur', function () {
      clearTimeout(testDebounceTimer);
      updateLiveStatusForTestMode();
    });
  }


  loadLogs();
});