const pad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "OK"];

export function PinPadPreview() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {pad.map((key) => (
        <button
          key={key}
          type="button"
          className="touch-button rounded-2xl border border-zinc-200 bg-white text-lg font-semibold shadow-sm transition hover:border-teal-400 hover:bg-teal-50"
        >
          {key}
        </button>
      ))}
    </div>
  );
}
