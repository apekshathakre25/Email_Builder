document.addEventListener('DOMContentLoaded', async () => {

    try {
        const response = await fetch('/check-auth', {
            method: 'GET',
            credentials: 'include' 
        });

        const data = await response.json();

        if (data.authenticated) {
  
            console.log('[AUTH] User already authenticated, redirecting to interface');
            window.location.href = '/interface';
            return;
        }
    } catch (error) {
        console.log('[AUTH] Not authenticated or error checking auth:', error);

    }


    const urlParams = new URLSearchParams(window.location.search);
    const errorType = urlParams.get('error');

    if (errorType) {
        let message = '';
        switch (errorType) {
            case 'unauthorized':
                message = '🚫 Access Denied: Your email is not authorized to access this system. Please contact on +91 9307349162 or if you believe this is an error.';
                break;
            case 'auth_failed':
                message = '❌ Authentication Failed: An error occurred during login. Please try again.';
                break;
            case 'no_email':
                message = '⚠️ No Email Found: Could not retrieve your email from Google. Please try again.';
                break;
            default:
                message = '⚠️ An error occurred during login. Please try again.';
        }

        showAlert(message, 'error');


        window.history.replaceState({}, document.title, window.location.pathname);
    }

    const loginForm = document.getElementById('loginForm');
    const submitBtn = document.getElementById('submitBtn');
    const emailSelect = document.getElementById('email');
    const otpInput = document.getElementById('otp');
    const sendOtpBtn = document.getElementById('sendOtpBtn');


    function showAlert(message, type = 'error') {
        const alertBox = document.getElementById('errorAlert');
        const alertMessage = document.getElementById('errorMessage');
        const alertIcon = document.getElementById('alertIcon');

        alertMessage.textContent = message;

  
        if (type === 'success') {
            alertBox.className = 'alert alert-success';
            alertIcon.className = 'fas fa-check-circle';
        } else {
            alertBox.className = 'alert alert-error';
            alertIcon.className = 'fas fa-exclamation-circle';
        }

        alertBox.style.display = 'flex';


        setTimeout(() => {
            alertBox.style.display = 'none';
        }, 5000);
    }


    sendOtpBtn.addEventListener('click', async () => {
        const email = emailSelect.value;
        if (!email) {
            showAlert('⚠️ Please select an account first');
            return;
        }


        sendOtpBtn.disabled = true;
        sendOtpBtn.classList.add('loading');
        const originalText = sendOtpBtn.innerHTML;
        sendOtpBtn.innerHTML = '<span><i class="fas fa-spinner fa-spin"></i> Sending...</span>';

        try {
            const response = await fetch('/send-otp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ email })
            });

            const data = await response.json();
            if (data.success) {
                showAlert('✅ OTP sent successfully! Check your email.', 'success');
                otpInput.focus();
            } else {
                showAlert('❌ Failed to send OTP: ' + data.message);
            }
        } catch (error) {
            console.error('Error:', error);
            showAlert('❌ An error occurred while sending OTP');
        } finally {
            sendOtpBtn.disabled = false;
            sendOtpBtn.classList.remove('loading');
            sendOtpBtn.innerHTML = originalText;
        }
    });


    emailSelect.addEventListener('change', () => {
        if (emailSelect.value) {
            otpInput.focus();
        }
    });


    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();


        if (!emailSelect.value || !otpInput.value) {
            showAlert('⚠️ Please fill in all fields');
            return;
        }


        submitBtn.classList.add('loading');
        const btnText = submitBtn.querySelector('span');
        const btnIcon = submitBtn.querySelector('i');

        const originalText = btnText.textContent;
        btnText.textContent = 'Verifying...';
        btnIcon.className = 'fas fa-spinner fa-spin';

        try {
            const response = await fetch('/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: emailSelect.value,
                    otp: otpInput.value
                })
            });

            const data = await response.json();

            if (data.success) {
 
                window.location.href = '/interface';
            } else {

                showAlert('❌ ' + (data.message || 'Login failed'));
                btnText.textContent = originalText;
                btnIcon.className = 'fas fa-arrow-right';
                submitBtn.classList.remove('loading');
            }
        } catch (error) {
            console.error('Error:', error);
            showAlert('❌ An error occurred during login');
            btnText.textContent = originalText;
            btnIcon.className = 'fas fa-arrow-right';
            submitBtn.classList.remove('loading');
        }
    });


    document.addEventListener('mousemove', (e) => {
        const x = e.clientX / window.innerWidth;
        const y = e.clientY / window.innerHeight;

        const blob1 = document.querySelector('.blob-1');
        const blob2 = document.querySelector('.blob-2');

        if (blob1) blob1.style.transform = `translate(${x * 30}px, ${y * 30}px)`;
        if (blob2) blob2.style.transform = `translate(${-x * 20}px, ${-y * 20}px)`;
    });
});
