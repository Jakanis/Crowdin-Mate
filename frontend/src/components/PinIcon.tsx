/** Monochrome pin, so it takes the surrounding text colour instead of the
 * emoji's fixed red — which read as an alert next to muted panel chrome.
 * Tilted when unpinned and upright when pinned, same as before. */
export function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M6 1.5h4a1 1 0 0 1 .8 1.6L10 4.2v3.1l1.7 1.6a1 1 0 0 1-.7 1.7H9v3.9L8 16l-1-1.5v-3.9H5a1 1 0 0 1-.7-1.7L6 7.3V4.2L5.2 3.1A1 1 0 0 1 6 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
