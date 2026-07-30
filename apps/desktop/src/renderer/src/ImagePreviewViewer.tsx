import { useCallback, useEffect, useState } from "react";

export type ImagePreviewItem = {
  src: string;
  alt: string;
};

export type ImagePreviewViewerProps = {
  images: ImagePreviewItem[];
  index: number;
  zh: boolean;
  onClose(): void;
  onIndexChange(next: number): void;
};

export function ImagePreviewViewer(props: ImagePreviewViewerProps) {
  const { images, index, onClose, onIndexChange, zh } = props;
  const length = images.length;
  const safeIndex = length > 0 ? Math.min(Math.max(index, 0), length - 1) : 0;
  const current = length > 0 ? images[safeIndex] : undefined;
  const showNavigation = length > 1;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const goPrev = useCallback(() => {
    if (length <= 1) return;
    onIndexChange((safeIndex - 1 + length) % length);
  }, [length, onIndexChange, safeIndex]);

  const goNext = useCallback(() => {
    if (length <= 1) return;
    onIndexChange((safeIndex + 1) % length);
  }, [length, onIndexChange, safeIndex]);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [current?.src]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowRight") {
        if (length > 1) {
          event.preventDefault();
          goNext();
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        if (length > 1) {
          event.preventDefault();
          goPrev();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
    };
  }, [goNext, goPrev, length, onClose]);

  const closeLabel = zh ? "关闭图片查看" : "Close image viewer";
  const prevLabel = zh ? "上一张" : "Previous image";
  const nextLabel = zh ? "下一张" : "Next image";
  const counterLabel = zh ? "第 %1 张 / 共 %2 张" : "Image %1 of %2";
  const loadingLabel = zh ? "正在加载图片…" : "Loading image…";
  const failedLabel = zh ? "图片加载失败" : "Failed to load image";

  return (
    <div
      className="image-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={zh ? "图片查看器" : "Image viewer"}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Backspace" && event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
      tabIndex={-1}
    >
      <button
        type="button"
        className="image-viewer-close"
        aria-label={closeLabel}
        onClick={onClose}
      >
        <span aria-hidden="true">×</span>
      </button>
      {showNavigation && (
        <>
          <button
            type="button"
            className="image-viewer-nav prev"
            aria-label={prevLabel}
            onClick={goPrev}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            className="image-viewer-nav next"
            aria-label={nextLabel}
            onClick={goNext}
          >
            <span aria-hidden="true">›</span>
          </button>
        </>
      )}
      {current ? (
        <figure
          className="image-viewer"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="image-viewer-stage">
            {!loaded && !failed && (
              <span className="image-viewer-status" aria-live="polite">
                {loadingLabel}
              </span>
            )}
            {failed && (
              <span className="image-viewer-status failed" role="alert">
                {failedLabel}
              </span>
            )}
            {!failed && (
              <img
                key={current.src}
                className={`image-viewer-img${loaded ? " loaded" : ""}`}
                src={current.src}
                alt={current.alt}
                draggable={false}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
              />
            )}
          </div>
          <figcaption className="image-viewer-caption">
            <strong>{current.alt}</strong>
            <small>
              {counterLabel
                .replace("%1", String(safeIndex + 1))
                .replace("%2", String(length))}
            </small>
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}
