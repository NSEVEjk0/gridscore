import type { Metadata } from "next";
import { Newsreader, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Gridscore — address screening, paid per scan",
  description:
    "Paste an address, pay $0.75 USDC on GOAT Network, get 12 rule-based bars and an agent verdict built from public chain data.",
};

const X_URL = "https://x.com/CRYPTFRANI";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="wrap">
          <header className="site-header">
            <a className="wordmark" href="/">
              Gridscore
            </a>
            <nav>
              <a href={X_URL} target="_blank" rel="noreferrer">
                X
              </a>
            </nav>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <p style={{ margin: "0 0 6px" }}>
              Public chain data only. Gridscore is not financial advice and makes
              no guarantees.
            </p>
            <p style={{ margin: 0 }}>
              Built by @ckay ·{" "}
              <a href={X_URL} target="_blank" rel="noreferrer">
                {X_URL}
              </a>
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
