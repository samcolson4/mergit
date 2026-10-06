export const TEMPLATES = [
  {
    name: "Flowchart",
    w: 460, h: 380,
    source: `flowchart LR
  A[Idea] --> B{Worth it?}
  B -->|Yes| C[Build it]
  B -->|No| D[Park it]
  C --> E((Ship))`,
  },
  {
    name: "Sequence",
    w: 520, h: 380,
    source: `sequenceDiagram
  participant C as Client
  participant S as Server
  C->>S: Request
  S-->>C: Response`,
  },
  {
    name: "Class",
    w: 460, h: 380,
    source: `classDiagram
  class Board {
    +Frame[] frames
    +commit(message)
  }
  class Frame {
    +String source
    +render()
  }
  Board "1" --> "*" Frame`,
  },
  {
    name: "State",
    w: 420, h: 380,
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review
  Review --> Draft: changes requested
  Review --> Published
  Published --> [*]`,
  },
  {
    name: "Entity relationship",
    w: 480, h: 380,
    source: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  PRODUCT ||--o{ LINE_ITEM : "ordered in"`,
  },
  {
    name: "Mindmap",
    w: 520, h: 400,
    source: `mindmap
  root((mergit))
    Canvas
      Frames
      Pan and zoom
    Version control
      Branches
      Merges
    Mermaid`,
  },
];

const checkout = {
  id: "f-checkout", title: "Checkout flow", x: 0, y: 0, w: 480, h: 470,
  source: `flowchart TD
  Cart[Cart] --> Address[Shipping address]
  Address --> Payment{Payment method}
  Payment -->|Card| Card[Card form]
  Payment -->|PayPal| PayPal[PayPal redirect]
  Card --> Confirm[Order confirmed]
  PayPal --> Confirm`,
};

const login = {
  id: "f-login", title: "Login sequence", x: 540, y: 0, w: 560, h: 470,
  source: `sequenceDiagram
  actor U as User
  participant W as Web app
  participant A as Auth API
  U->>W: Enter email + password
  W->>A: POST /session
  A-->>W: 200 + session cookie
  W-->>U: Redirect to dashboard`,
};

const orders = {
  id: "f-orders", title: "Order lifecycle", x: 0, y: 530, w: 480, h: 420,
  source: `stateDiagram-v2
  [*] --> Pending
  Pending --> Paid: payment ok
  Pending --> Cancelled: timeout
  Paid --> Shipped
  Shipped --> Delivered
  Delivered --> [*]`,
};

/** Builds a small history with a feature branch that merges cleanly into main. */
export function seedRepo(core, author) {
  let t = Date.now() - 1000 * 60 * 60 * 5;
  const time = () => (t += 1000 * 60 * 23);
  const commit = (frames, message) => core.call("commit", { board: { frames }, message, author, time: time() });

  core.call("init", { board: { frames: [checkout, login] }, author, time: time() });
  commit([checkout, login, orders], "Add order lifecycle");

  core.call("branch", { name: "feature/express-pay", switch: true });
  const checkout2 = {
    ...checkout,
    source: checkout.source.replace(
      "Address --> Payment",
      "Cart -->|Express| Express[Apple / Google Pay]\n  Express --> Confirm\n  Address --> Payment",
    ),
  };
  commit([checkout2, login, orders], "Add express pay path");
  const orders2 = {
    ...orders,
    source: orders.source.replace(
      "Delivered --> [*]",
      "Delivered --> [*]\n  Delivered --> Refunded: return accepted\n  Refunded --> [*]",
    ),
  };
  commit([checkout2, login, orders2], "Model refunds");

  core.call("checkout", { rev: "main" });
  const login2 = {
    ...login,
    source: login.source.replace(
      "A-->>W: 200 + session cookie",
      "A-->>W: 202 needs 2FA\n  W-->>U: Ask for code\n  U->>W: 6-digit code\n  W->>A: POST /session/verify\n  A-->>W: 200 + session cookie",
    ),
  };
  commit([checkout, login2, orders], "Require 2FA at login");
  return { frames: [checkout, login2, orders] };
}

/** What a brand-new board starts with. */
export const STARTER = {
  frames: [
    {
      id: "f-welcome", title: "Welcome", x: 0, y: 0, w: 520, h: 420,
      source: `flowchart LR
  A[Double-click me] --> B[Edit the Mermaid source]
  B --> C{Happy with it?}
  C -->|Yes| D[Commit]
  C -->|Not yet| B`,
    },
  ],
};
