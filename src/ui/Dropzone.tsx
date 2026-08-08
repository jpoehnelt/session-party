import { useRef, useState, type DragEvent } from "react";
import { cx } from "./cx";
import { UploadIcon } from "./icons";

export interface DropzoneProps {
  accept?: string;
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropzone({
  accept,
  onFiles,
  multiple = true,
  hint,
  disabled = false,
  className,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  }

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
      className={cx(
        "relative flex min-h-36 flex-col items-center justify-center rounded-card border border-dashed px-6 py-8 text-center transition-colors",
        dragging
          ? "border-accent bg-accent-soft/60"
          : "border-line-strong bg-surface hover:border-accent/50 hover:bg-surface-muted/40",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const files = event.currentTarget.files
            ? Array.from(event.currentTarget.files)
            : [];
          if (files.length > 0) onFiles(files);
          event.currentTarget.value = "";
        }}
        className="sr-only"
      />
      <div className="mb-3 flex size-9 items-center justify-center rounded-control bg-accent-soft text-accent">
        <UploadIcon className="size-5" />
      </div>
      <p className="text-sm font-medium text-ink">
        Drop files here, or{" "}
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="rounded-sm text-accent outline-none hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          choose files
        </button>
      </p>
      {hint && <p className="mt-1 text-[13px] text-ink-faint">{hint}</p>}
    </div>
  );
}
