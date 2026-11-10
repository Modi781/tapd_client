import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Globe,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import clsx from "clsx";

import { formatBytes, mediaSrc } from "../lib/api";

export type PreviewItem = {
  url: string;
  kind: "image" | "video";
  label: string;
  size?: number;
};

type Props = {
  items: PreviewItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onOpenExternal: (url: string, mode: "file" | "browser") => void;
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

/** Full-screen resource preview with zoom, prev/next and a thumbnail strip. */
export function MediaPreview(props: Props) {
  const { items, index, onIndexChange, onClose, onOpenExternal } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const centeredOnce = useRef(false);
  const [zoom, setZoom] = useState(1);

  const current = items[index];

  const zoomBy = useCallback((factor: number) => {
    setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value * factor)));
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = (index + delta + items.length) % items.length;
      onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  // Reset zoom when switching resources.
  useEffect(() => {
    setZoom(1);
  }, [index]);

  // Keep the active thumbnail in the middle of the rail. The first centering is
  // instant (so the preview opens already centered), later ones slide.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const thumb = thumbRefs.current[index];
    if (!thumb) return;

    const stripRect = strip.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const delta =
      thumbRect.left + thumbRect.width / 2 - (stripRect.left + stripRect.width / 2);

    strip.scrollBy({
      left: delta,
      behavior: centeredOnce.current ? "smooth" : "auto",
    });
    centeredOnce.current = true;
  }, [index, items.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          go(1);
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomBy(1.25);
          break;
        case "-":
        case "_":
          event.preventDefault();
          zoomBy(0.8);
          break;
        case "0":
          event.preventDefault();
          setZoom(1);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, onClose, zoomBy]);

  // Wheel zooms the image; registered natively so it can preventDefault.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!current || current.kind !== "image") return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [current, zoomBy]);

  if (!current) return null;

  const source = mediaSrc(current.url);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-slate-950/95 text-slate-100">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium" title={current.label}>
            {current.label}
          </div>
          <div className="text-[10px] text-slate-400">
            {index + 1} / {items.length}
            {current.size ? ` · ${formatBytes(current.size)}` : ""}
            {current.kind === "video" ? " · 视频" : ""}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {current.kind === "image" ? (
            <>
              <IconButton label="缩小" onClick={() => zoomBy(0.8)}>
                <ZoomOut size={15} />
              </IconButton>
              <span className="w-11 text-center font-mono text-[11px] text-slate-300">
                {Math.round(zoom * 100)}%
              </span>
              <IconButton label="放大" onClick={() => zoomBy(1.25)}>
                <ZoomIn size={15} />
              </IconButton>
              <IconButton label="适应窗口" onClick={() => setZoom(1)}>
                <Maximize2 size={14} />
              </IconButton>
            </>
          ) : null}
          <IconButton
            label="用本地应用打开"
            onClick={() => onOpenExternal(current.url, "file")}
          >
            <ExternalLink size={15} />
          </IconButton>
          <IconButton
            label="在浏览器中打开"
            onClick={() => onOpenExternal(current.url, "browser")}
          >
            <Globe size={15} />
          </IconButton>
          <IconButton label="关闭预览" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          {current.kind === "video" ? (
            source ? (
              <video
                key={current.url}
                src={source}
                controls
                autoPlay
                playsInline
                className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
              />
            ) : (
              <Hint text="预览服务尚未就绪，可用「在浏览器中打开」" />
            )
          ) : source ? (
            <img
              key={current.url}
              src={source}
              alt={current.label}
              draggable={false}
              onDoubleClick={() => setZoom((value) => (value > 1 ? 1 : 2))}
              style={{ transform: `scale(${zoom})` }}
              className="max-h-[calc(100vh-13rem)] max-w-full origin-center select-none rounded-lg bg-white/5 shadow-2xl transition-transform duration-100"
            />
          ) : (
            <Hint text="预览服务尚未就绪，可用「在浏览器中打开」" />
          )}
        </div>

        {items.length > 1 ? (
          <>
            <button
              type="button"
              aria-label="上一个资源"
              onClick={() => go(-1)}
              className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/70 text-slate-200 transition hover:bg-slate-800"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="下一个资源"
              onClick={() => go(1)}
              className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/70 text-slate-200 transition hover:bg-slate-800"
            >
              <ChevronRight size={20} />
            </button>
          </>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-white/10 bg-slate-950/80 px-3 py-2">
        {/* Centered rail: the active thumbnail sits in the middle and the
            previously active one slides left as you move on. */}
        <div
          ref={stripRef}
          className="flex gap-2 overflow-x-auto px-[calc(50%-1.75rem)] pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item, itemIndex) => (
            <button
              key={`${item.url}-${itemIndex}`}
              ref={(element) => {
                thumbRefs.current[itemIndex] = element;
              }}
              type="button"
              onClick={() => onIndexChange(itemIndex)}
              title={item.label}
              className={clsx(
                "relative h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 transition",
                itemIndex === index
                  ? "border-sky-400"
                  : "border-transparent opacity-60 hover:opacity-100",
              )}
            >
              {item.kind === "image" && mediaSrc(item.url) ? (
                <img
                  src={mediaSrc(item.url)}
                  alt={item.label}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="grid h-full w-full place-items-center bg-slate-800 text-slate-300">
                  <Film size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white"
    >
      {props.children}
    </button>
  );
}

function Hint(props: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/20 px-4 py-6 text-xs text-slate-400">
      {props.text}
    </div>
  );
}
