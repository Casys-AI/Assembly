import type { PageProps } from "fresh";

export default function App({ Component }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Assembly</title>
      </head>
      <body f-client-nav>
        <Component />
      </body>
    </html>
  );
}
