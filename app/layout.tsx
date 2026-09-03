import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const title = 'AIMEM Design Studio — Production X1';
const description =
  'Evidence-gated, real-time system planning for the 16-high, 8,192-lane AIMEM-X1 production architecture and its eight-stack accelerator package.';

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get('x-forwarded-host')?.split(',')[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get('host');
  const safeHost = requestHost && /^[a-z0-9.-]+(?::\d+)?$/i.test(requestHost)
    ? requestHost
    : 'localhost:3000';
  const forwardedProtocol = requestHeaders.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
    ? forwardedProtocol
    : safeHost.startsWith('localhost') ? 'http' : 'https';
  const origin = `${protocol}://${safeHost}`;
  const socialImage = `${origin}/og-x1.png`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    openGraph: {
      type: 'website',
      title,
      description,
      images: [{ url: socialImage, width: 1731, height: 909, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
