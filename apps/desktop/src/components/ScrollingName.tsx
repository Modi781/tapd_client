import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

type Props = {
  text: string;
  className?: string;
};

/**
 * One-line project name. If it overflows, hovering scrolls it in place instead
 * of truncating; the speed scales with the overflow distance.
 */
export function ScrollingName({ text, className }: Props) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [hovered, setHovered] = useState(false);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () =>
      setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [text]);

  const duration = Math.min(2500, Math.max(400, overflow * 12));

  return (
    <span
      ref={outerRef}
      aria-label={text}
      className={clsx("relative block min-w-0 overflow-hidden", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap transition-transform ease-out"
        style={{
          transform:
            hovered && overflow > 0 ? `translateX(-${overflow}px)` : "translateX(0)",
          transitionDuration: `${duration}ms`,
        }}
      >
        {text}
      </span>
    </span>
  );
}
