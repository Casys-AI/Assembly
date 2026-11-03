import { App, staticFiles } from "fresh";

// The compiled handler is mounted by the existing backend's single listener.
export const app = new App();
app.use(staticFiles());
app.fsRoutes();
