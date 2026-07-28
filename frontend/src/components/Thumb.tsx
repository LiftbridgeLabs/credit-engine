import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { thumbUrl } from "../lib/api";

/** Poster/thumbnail for a browse row or grid card — falls back to a placeholder icon if the item
 * has none (has_thumb is false) or the image fails to load (e.g. Plex unreachable at that moment).
 * "sm" is the small row-icon size used in list views; "poster" fills its parent (meant for a
 * fixed-aspect-ratio container in a grid). */
export function Thumb({
  serverId,
  ratingKey,
  hasThumb,
  size = "sm",
}: {
  serverId: number;
  ratingKey: number;
  hasThumb: boolean;
  size?: "sm" | "poster";
}) {
  const [failed, setFailed] = useState(false);

  if (size === "poster") {
    if (!hasThumb || failed) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-400">
          <ImageIcon className="h-8 w-8" />
        </div>
      );
    }
    return (
      <img
        src={thumbUrl(serverId, ratingKey)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover bg-slate-100 dark:bg-slate-800"
      />
    );
  }

  if (!hasThumb || failed) {
    return (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-slate-100 dark:bg-slate-800 text-slate-400">
        <ImageIcon className="h-4 w-4" />
      </span>
    );
  }
  return (
    <img
      src={thumbUrl(serverId, ratingKey)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded object-cover bg-slate-100 dark:bg-slate-800"
    />
  );
}
