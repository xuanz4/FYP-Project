document.addEventListener('click', (event) => {
  const openButton = event.target.closest('[data-open-dialog]');
  if (openButton) {
    const dialog = document.getElementById(openButton.dataset.openDialog);
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  if (event.target.closest('[data-close-dialog]')) {
    const dialog = event.target.closest('dialog');
    if (dialog) dialog.close();
  }

  const confirmButton = event.target.closest('[data-confirm="true"]');
  if (confirmButton && !window.confirm('Are you sure?')) {
    event.preventDefault();
  }
});
