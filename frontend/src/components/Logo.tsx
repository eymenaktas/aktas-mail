import { useId } from "react";

/**
 * Aktaş Mail markası.
 *
 * Degrade karo üstünde iki tonlu "A": gövde beyaz, çapraz çubuk açık
 * mavi. Çubuk aynı zamanda bir zarf katlanmasını andırıyor.
 *
 * Not: degradenin id'si `useId` ile üretiliyor — sayfada birden fazla
 * logo varsa sabit bir id çakışır ve ikinci logo boş görünürdü.
 */
export function Logo({
  size = 44,
  muted = false,
  className,
}: {
  size?: number;
  muted?: boolean;
  className?: string;
}) {
  const id = useId();
  const gradId = `am-logo-${id.replace(/:/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="Aktaş Mail"
      style={muted ? { opacity: 0.28 } : undefined}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b9bff" />
          <stop offset="1" stopColor="#1558d6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="12" fill={`url(#${gradId})`} />
      <path d="M24 13 L34 34" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M24 13 L14 34" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M18.4 27.5 H29.6" stroke="#c2e7ff" strokeWidth="4.4" strokeLinecap="round" />
    </svg>
  );
}
