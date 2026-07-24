(() => {
  const centre = document.querySelector('[data-notification-centre]');
  if (!centre) return;

  const toggle = centre.querySelector('[data-notification-toggle]');
  const panel = centre.querySelector('[data-notification-panel]');
  const list = centre.querySelector('[data-notification-list]');
  const count = centre.querySelector('[data-notification-count]');
  const readAll = centre.querySelector('[data-notification-read-all]');
  const filters = [...centre.querySelectorAll('[data-notification-filter]')];
  let notifications = [];
  let activeFilter = 'all';
  let unreadTotal = 0;

  const typeIcons = {
    RFI_SENT: '\u2709',
    RFI_REPLIED: '\u21A9',
    RFI_FAILED: '!',
    CASE_ASSIGNED: '\u263A',
    CASE_ESCALATED: '\u2197',
    STR_UPDATED: '\u25A4',
  };

  const relativeTime = (value) => {
    const elapsed = Date.now() - new Date(value).getTime();
    const minutes = Math.max(0, Math.floor(elapsed / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  const setCount = (value) => {
    const unread = Number(value) || 0;
    unreadTotal = unread;
    count.textContent = unread > 99 ? '99+' : String(unread);
    count.hidden = unread === 0;
  };

  const markRead = async (notificationId) => {
    const response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PATCH' });
    return response.ok;
  };

  const render = () => {
    const items = activeFilter === 'unread'
      ? notifications.filter((item) => !item.is_read)
      : notifications;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = activeFilter === 'unread' ? 'No unread notifications.' : 'No notifications yet.';
      list.append(empty);
      return;
    }

    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notification-item${item.is_read ? '' : ' is-unread'}`;
      button.setAttribute('aria-label', `${item.title}. ${item.message}`);

      const icon = document.createElement('span');
      icon.className = `notification-type-icon type-${String(item.notification_type || '').toLowerCase()}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = typeIcons[item.notification_type] || '\u25C7';

      const content = document.createElement('span');
      content.className = 'notification-item-content';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const message = document.createElement('span');
      message.textContent = item.message;
      const meta = document.createElement('span');
      meta.className = 'notification-item-meta';
      const time = document.createElement('time');
      time.dateTime = item.created_at;
      time.textContent = relativeTime(item.created_at);
      const view = document.createElement('span');
      view.className = 'notification-view-label';
      view.textContent = item.target_url ? 'View' : '';
      meta.append(time, view);
      content.append(title, message, meta);

      if (!item.is_read) {
        const dot = document.createElement('span');
        dot.className = 'notification-unread-dot';
        dot.setAttribute('aria-label', 'Unread');
        button.append(icon, content, dot);
      } else {
        button.append(icon, content);
      }

      button.addEventListener('click', async () => {
        if (!item.is_read && await markRead(item.notification_id)) {
          item.is_read = 1;
          setCount(Math.max(0, unreadTotal - 1));
        }
        closePanel();
        if (item.target_url) window.location.assign(item.target_url);
        else render();
      });
      list.append(button);
    });
  };

  const refresh = async () => {
    try {
      const response = await fetch('/api/notifications?limit=12', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const result = await response.json();
      notifications = result.notifications || [];
      setCount(result.unreadCount);
      render();
    } catch {
      // Polling failures are intentionally silent; the next interval retries.
    }
  };

  const closePanel = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open notifications');
  };

  const openPanel = () => {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close notifications');
    refresh();
  };

  toggle.addEventListener('click', () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  filters.forEach((filter) => {
    filter.addEventListener('click', () => {
      activeFilter = filter.dataset.notificationFilter;
      filters.forEach((item) => {
        const active = item === filter;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      render();
    });
  });

  readAll.addEventListener('click', async () => {
    const response = await fetch('/api/notifications/read-all', { method: 'PATCH' });
    if (!response.ok) return;
    notifications.forEach((item) => { item.is_read = 1; });
    setCount(0);
    render();
  });

  document.addEventListener('click', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) closePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      closePanel();
      toggle.focus();
    }
  });

  refresh();
  setInterval(refresh, 20 * 1000);
})();
