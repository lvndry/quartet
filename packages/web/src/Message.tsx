import type React from "react";
import { memo } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/** Schemes that cannot execute. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

export const MessageBody = memo(function MessageBody({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ href, children }) => {
            const safe = typeof href === "string" && SAFE_SCHEME.test(href);
            return safe ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          table: ({ children }) => (
            <div className="md-scroll">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre className="md-scroll">{children}</pre>,
          img: () => null,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
