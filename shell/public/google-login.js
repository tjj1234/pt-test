'use strict';
(() => {
  const button = document.getElementById('google-login');
  const error = document.getElementById('login-error');
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'google_auth') {
    error.textContent = 'Google 登录未完成，请重试。';
    error.hidden = false;
    history.replaceState(null, '', '/login');
  }
  button.addEventListener('click', () => { window.location.assign('/api/auth/google/start'); });
  fetch('/api/auth/google/status', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('unavailable')))
    .then((status) => {
      button.disabled = status.configured !== true;
      button.textContent = status.configured === true ? '使用 Google 登录' : 'Google 登录暂未配置';
      if (status.configured !== true) {
        error.textContent = '登录服务尚未完成配置，请联系管理员。';
        error.hidden = false;
      }
    })
    .catch(() => {
      button.disabled = true;
      button.textContent = '登录服务暂不可用';
      error.textContent = '暂时无法连接登录服务，请稍后重试。';
      error.hidden = false;
    });
})();
