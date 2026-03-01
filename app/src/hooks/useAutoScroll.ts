import { useRef, useEffect, useCallback, useState } from "react";

export function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledUp = useRef(false);

  const checkAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 80;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
    userScrolledUp.current = !atBottom;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    userScrolledUp.current = false;
    setIsAtBottom(true);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkAtBottom);
    return () => el.removeEventListener("scroll", checkAtBottom);
  }, [checkAtBottom]);

  return { containerRef, isAtBottom, scrollToBottom };
}
