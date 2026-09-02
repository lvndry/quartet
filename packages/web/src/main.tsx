import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "katex/dist/katex.min.css";
import "./styles.css";

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<StrictMode><App /></StrictMode>);
