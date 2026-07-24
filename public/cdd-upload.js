(() => {
  const forms = document.querySelectorAll('[data-cdd-upload-form]');

  forms.forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const feedback = form.querySelector('[data-upload-feedback]');
      const submitButton = form.querySelector('button[type="submit"]');
      const originalButtonText = submitButton?.textContent || 'Upload Document';

      if (feedback) {
        feedback.textContent = '';
        feedback.classList.remove('is-success');
      }
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Validating file...';
      }

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          const contentType = response.headers.get('content-type') || '';
          const result = contentType.includes('application/json')
            ? await response.json()
            : { message: await response.text() };
          throw new Error(result.message || 'The document could not be uploaded.');
        }

        if (feedback) {
          feedback.textContent = 'Document uploaded successfully. Refreshing the document list...';
          feedback.classList.add('is-success');
        }
        // The refreshed page contains the latest checklist and document count. Preserve the
        // expanded panel so the user can immediately upload another supporting document.
        sessionStorage.setItem(`merchantCddExpanded:${window.location.pathname}`, 'true');
        window.location.reload();
      } catch (error) {
        if (feedback) {
          feedback.textContent = error.message;
          feedback.classList.remove('is-success');
        }
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalButtonText;
        }
      }
    });
  });
})();
