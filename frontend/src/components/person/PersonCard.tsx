"use client";

import type { Person } from "@/types";
import { LOW_CONFIDENCE_THRESHOLD } from "@/lib/env";

interface PersonCardProps {
  person: Person;
  selected: boolean;
  onSelect: (personId: string) => void;
  index: number;
}

export function PersonCard({ person, selected, onSelect, index }: PersonCardProps) {
  const isLowConfidence = person.confidence < LOW_CONFIDENCE_THRESHOLD;
  const confidencePct = Math.round(person.confidence * 100);
  const clipCount = new Set(person.appearances.map((a) => a.clip_id)).size;

  const handleClick = () => onSelect(person.person_id);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(person.person_id);
    }
  };

  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={`Person ${index + 1}${isLowConfidence ? " (low confidence)" : ""}. Confidence: ${confidencePct}%. Appears in ${clipCount} clip${clipCount !== 1 ? "s" : ""}.`}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        "relative rounded-xl overflow-hidden cursor-pointer",
        "border-2 transition-all focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-gray-950",
        selected
          ? "border-red-500 ring-1 ring-red-500"
          : "border-gray-700 hover:border-gray-500",
      ].join(" ")}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-gray-800">
        {person.thumbnail_url ? (
          <img
            src={person.thumbnail_url}
            alt={`Person ${index + 1} face crop`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-4xl">
            👤
          </div>
        )}
      </div>

      {/* Selection checkmark */}
      {selected && (
        <div
          aria-hidden="true"
          className="absolute top-2 right-2 w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-white text-xs font-bold"
        >
          ✓
        </div>
      )}

      {/* Low confidence badge */}
      {isLowConfidence && (
        <div
          aria-hidden="true"
          className="absolute top-2 left-2 bg-yellow-900 border border-yellow-600 text-yellow-300 text-xs px-1.5 py-0.5 rounded font-medium"
          title="Low confidence — face targeting may be less accurate"
        >
          Low conf.
        </div>
      )}

      {/* Info strip */}
      <div className="bg-gray-900/90 p-2.5">
        <div className="flex justify-between items-center gap-2">
          <span className="text-xs text-gray-300 font-medium">
            {clipCount} clip{clipCount !== 1 ? "s" : ""}
          </span>
          <span
            className={[
              "text-xs font-semibold tabular-nums",
              isLowConfidence ? "text-yellow-400" : "text-green-400",
            ].join(" ")}
          >
            {confidencePct}%
          </span>
        </div>
        {isLowConfidence && (
          <p className="text-xs text-yellow-500 mt-1 leading-tight">
            Low confidence — targeting may be less accurate
          </p>
        )}
      </div>
    </div>
  );
}
