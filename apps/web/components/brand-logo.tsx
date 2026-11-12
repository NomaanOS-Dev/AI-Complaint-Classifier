"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ThemeToggleButton } from "./theme-provider";

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="brand-mark-svg"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="nomaanosLogoGrad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#4F46E5" />
            <stop offset="55%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#0EA5E9" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="36" height="36" rx="11" fill="url(#nomaanosLogoGrad)" />
        {/* Layered speech/ticket shield + AI spark */}
        <path
          d="M12 14.5C12 12.8431 13.3431 11.5 15 11.5H25C26.6569 11.5 28 12.8431 28 14.5V21.5C28 23.1569 26.6569 24.5 25 24.5H18.5L13.5 28.5V24.5H15C13.3431 24.5 12 23.1569 12 21.5V14.5Z"
          stroke="white"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
        <path
          d="M20 14.8L21.05 17.2L23.5 18.25L21.05 19.3L20 21.7L18.95 19.3L16.5 18.25L18.95 17.2L20 14.8Z"
          fill="white"
        />
      </svg>
    </span>
  );
}

export function BrandLockup({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand-center" href={href}>
      <BrandMark size={38} />
      <span className="brand-stack">
        <span className="brand-title">
          nomaan<span className="brand-light">OS</span>
        </span>
        <span className="brand-subtitle">ai-complaint analysis</span>
      </span>
    </Link>
  );
}

export function TwoLayerNavbar({
  children,
  showThemeToggle = true
}: {
  children?: ReactNode;
  showThemeToggle?: boolean;
}) {
  return (
    <header className="two-layer-navbar">
      <div className="navbar-layer-brand">
        <BrandLockup href="/" />
      </div>
      <nav className="navbar-layer-links" aria-label="Main navigation">
        <div className="navbar-links-inner">
          {children}
          {showThemeToggle && <ThemeToggleButton />}
        </div>
      </nav>
    </header>
  );
}
