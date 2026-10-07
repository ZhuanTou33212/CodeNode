import { useEffect, useRef, useState } from 'react';

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
  );
}

/** Only bare Space outside text entry activates panning; OS/IME shortcuts pass through. */
export function useSpacePan() {
  const [spacePressed, setSpacePressed] = useState(false);
  const spacePressedRef = useRef(false);

  useEffect(() => {
    const setPressed = (pressed: boolean) => {
      spacePressedRef.current = pressed;
      setSpacePressed(pressed);
    };
    const reset = () => setPressed(false);
    const down = (event: KeyboardEvent) => {
      const target = event.composedPath()[0] || event.target;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
          event.isComposing || event.keyCode === 229 ||
          isInteractive(target) || isInteractive(document.activeElement)) {
        reset();
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        setPressed(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' || ['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) reset();
    };
    const focus = (event: FocusEvent) => {
      if (isInteractive(event.composedPath()[0] || event.target)) reset();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    window.addEventListener('contextmenu', reset);
    window.addEventListener('compositionstart', reset);
    window.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
      window.removeEventListener('contextmenu', reset);
      window.removeEventListener('compositionstart', reset);
      window.removeEventListener('focusin', focus);
    };
  }, []);

  return { spacePressed, spacePressedRef };
}
