import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
  title: 'Sneaker Drop - Limited Edition',
  description: 'Limited 20 pair sneaker drop with live queue and atomic holds.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: '#0a0a0c',
          color: '#f0f0f4',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        {children}
      </body>
    </html>
  );
}
