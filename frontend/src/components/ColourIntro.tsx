import type { Mix } from "../lib/colour";

interface Props {
  mix: Mix;
}

const LO = 0.35;
const HI = 5.3;
// log axis: the visible band is tiny next to SPHEREx's range on a linear axis
const pos = (wl: number) => ((Math.log(wl) - Math.log(LO)) / (Math.log(HI) - Math.log(LO))) * 100;

/**
 * "What am I looking at?" for Colour mode: your eyes vs SPHEREx on one wavelength axis, and which
 * three slices are painted red, green and blue right now.
 */
export function ColourIntro({ mix }: Props) {
  const win = (k: "r" | "g" | "b", colour: string, label: string) => (
    <g key={k}>
      <rect x={`${pos(mix[k].lo)}%`} y="30" width={`${Math.max(0.8, pos(mix[k].hi) - pos(mix[k].lo))}%`} height="14" fill={colour} rx="2" />
      <text x={`${(pos(mix[k].lo) + pos(mix[k].hi)) / 2}%`} y="56" textAnchor="middle" className="fill-slate-300 text-[9px]">
        {label}
      </text>
    </g>
  );
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <svg width="100%" height="62" role="img" aria-label="Wavelength axis: human eyes see 0.4 to 0.7 micrometres; SPHEREx sees 0.75 to 5 micrometres in 102 colours; three slices are shown as red, green and blue.">
        <defs>
          <linearGradient id="eye" x1="0" x2="1">
            <stop offset="0" stopColor="#7c3aed" />
            <stop offset="0.25" stopColor="#2563eb" />
            <stop offset="0.45" stopColor="#16a34a" />
            <stop offset="0.65" stopColor="#facc15" />
            <stop offset="0.85" stopColor="#f97316" />
            <stop offset="1" stopColor="#dc2626" />
          </linearGradient>
        </defs>
        <rect x={`${pos(0.38)}%`} y="10" width={`${pos(0.75) - pos(0.38)}%`} height="14" fill="url(#eye)" rx="2" />
        <text x={`${pos(0.38)}%`} y="8" className="fill-slate-300 text-[9px]">
          your eyes
        </text>
        <rect x={`${pos(0.75)}%`} y="10" width={`${pos(5.0) - pos(0.75)}%`} height="14" fill="rgba(56,189,248,0.12)" stroke="rgba(56,189,248,0.6)" rx="2" />
        <text x={`${pos(1.9)}%`} y="21" textAnchor="middle" className="fill-sky-200 text-[9px]">
          SPHEREx: 102 infrared colours
        </text>
        {win("b", "#3b82f6", "blue")}
        {win("g", "#22c55e", "green")}
        {win("r", "#ef4444", "red")}
        {[0.5, 1, 2, 5].map((w) => (
          <text key={w} x={`${pos(w)}%`} y="44" dy="0" textAnchor="middle" className="fill-slate-400 text-[8px]" transform="translate(0 16)">
            {w} µm
          </text>
        ))}
      </svg>
      <p className="mt-1 text-xs leading-relaxed text-slate-300">
        Your eyes see a thin slice of light. SPHEREx sees far into the infrared and splits it into 102 colours. A picture can only show three, so we pick three slices
        and paint them <span className="text-red-400">red</span>, <span className="text-green-400">green</span> and <span className="text-blue-400">blue</span>.
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
        <b className="text-white">Why the colours matter:</b> molecules such as water and methane absorb light only at their own wavelengths. Put one slice on such a wavelength,
        and anything containing that molecule loses that colour. That's how astronomers spot cold brown dwarfs and water-rich stars at a glance.
      </p>
    </div>
  );
}
