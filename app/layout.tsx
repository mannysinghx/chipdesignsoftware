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

const title = 'AIMEM Design Studio — Agent Mission Control';
const description =
  'Governed, evidence-aware AI-agent orchestration for end-to-end open-source chip design from requirements through production release boundaries.';

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
  const socialImage = `${origin}/og-agents.png`;

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
