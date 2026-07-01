let undoToastTimer = null;

function ensureUndoToast() {
  let toast = document.getElementById('undo-toast');
  if (toast) return toast;

  toast = document.createElement('div');
  toast.id = 'undo-toast';
  toast.className = 'undo-toast';
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);
  return toast;
}

export function showUndoToast(message, onUndo, options = {}) {
  const toast = ensureUndoToast();
  const duration = options.duration || 9000;

  if (undoToastTimer) clearTimeout(undoToastTimer);

  toast.innerHTML = `
    <span>${message}</span>
    ${onUndo ? '<button type="button">撤销</button>' : ''}
  `;
  toast.classList.add('show');

  const close = () => {
    toast.classList.remove('show');
    toast.innerHTML = '';
  };

  const button = toast.querySelector('button');
  if (button && onUndo) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      await onUndo();
      close();
      showUndoToast('已撤销', null, { duration: 2200 });
    });
  }

  undoToastTimer = setTimeout(close, duration);
}
