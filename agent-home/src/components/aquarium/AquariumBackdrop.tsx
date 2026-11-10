/** The static water: gradient, drifting light rays and the seabed. */
export function AquariumBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#0a6fa8_0%,#07508a_35%,#053467_70%,#031f45_100%)]" />
      <div className="aq-tank-rays absolute -top-1/4 left-0 h-[120%] w-full">
        {[8, 26, 47, 66, 84].map((left, i) => (
          <span
            key={left}
            className="aq-tank-ray absolute top-0 h-full"
            style={{ left: `${left}%`, width: `${6 + (i % 3) * 3}%`, animationDelay: `${-i * 2.3}s` }}
          />
        ))}
      </div>
      <svg
        className="absolute bottom-0 left-0 h-[13%] max-h-24 min-h-12 w-full"
        viewBox="0 0 1200 100"
        preserveAspectRatio="none"
      >
        <path d="M0 40C150 20 300 52 450 38C600 24 760 50 900 34C1020 22 1110 36 1200 30V100H0Z" fill="#c9a86a" />
        <path d="M0 62C180 48 340 70 520 58C700 46 860 70 1040 56C1110 50 1160 54 1200 52V100H0Z" fill="#b08c50" />
        <ellipse cx="180" cy="62" rx="46" ry="20" fill="#6f7a85" />
        <ellipse cx="215" cy="70" rx="30" ry="14" fill="#86919c" />
        <ellipse cx="940" cy="64" rx="56" ry="22" fill="#6f7a85" />
        <ellipse cx="760" cy="80" rx="22" ry="9" fill="#86919c" />
      </svg>
      {[6, 18, 37, 58, 72, 91].map((left, i) => (
        <span
          key={left}
          className="aq-tank-weed absolute bottom-[4%] w-3 origin-bottom rounded-t-full"
          style={{
            left: `${left}%`,
            height: `${10 + (i % 3) * 5}%`,
            background: i % 2 ? "#2fa36b" : "#3cc47f",
            animationDelay: `${-i * 1.1}s`,
          }}
        />
      ))}
    </div>
  );
}
