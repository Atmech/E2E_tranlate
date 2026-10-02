const form = document.querySelector('#login');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const error = document.querySelector('#error');
  button.disabled = true; error.textContent = ''; button.textContent = 'Signing in…';
  try {
    const response = await fetch('/monitor/login', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-monitor-request': '1' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    form.password.value = '';
    if (response.ok) { location.replace('/monitor'); return; }
    error.textContent = (await response.json()).message;
  } catch { error.textContent = 'Could not reach the server. Please try again.'; }
  finally { button.disabled = false; button.textContent = 'Sign in'; }
});
