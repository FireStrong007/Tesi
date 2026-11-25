/**
 * Does an account still name the same person in the data copy in use? An account keeps both the
 * participant's id and code (participant.name, unique); the id alone could belong to someone else
 * after the research database is recreated or restored. Checked at every login and every request
 * for data (app.ts), and for every account in the administrator's list. The data copy is only read.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../log";
import { SYSTEM_ACTOR, type Account, type AuthStore } from "./store";

export type Link =
  | { state: "ok" }
  /** made before the codes were kept: never valid again */
  | { state: "recreate" }
  /** the code is in the copy with another id: only an administrator may move the account to it */
  | { state: "relink"; participantId: number }
  /** the code is not in the copy any more: blocked */
  | { state: "missing" };

/** what the participant reads when their account cannot show data */
export const LINK_MESSAGES = {
  recreate: "Questo account non è più valido e va ricreato: chiedi un nuovo account al responsabile dello studio.",
  review: "Il tuo account è da verificare: il responsabile dello studio deve controllarlo. Nel frattempo i dati non sono disponibili.",
} as const;

/** The account against the copy, without changing anything. */
export function checkLink(db: DatabaseSync, a: Account): Link {
  if (a.role !== "participant") return { state: "ok" };
  if (a.linkState === "recreate" || !a.participantCode || a.participantId == null) return { state: "recreate" };
  const atId = db.prepare("SELECT name FROM participant WHERE id = ?").get(a.participantId) as { name: string } | undefined;
  if (atId?.name === a.participantCode) return { state: "ok" };
  const byCode = db.prepare("SELECT id FROM participant WHERE name = ?").get(a.participantCode) as { id: number } | undefined;
  return byCode ? { state: "relink", participantId: byCode.id } : { state: "missing" };
}

/**
 * checkLink, with the account's state kept up to date: «da verificare» as soon as id and code no
 * longer go together, active again by itself when they do again (never moved to another id: that
 * is the administrator's relink). Each change is written once in the audit log.
 */
export function enforceLink(auth: AuthStore, db: DatabaseSync, a: Account, log?: Logger): Link {
  const link = checkLink(db, a);
  if (a.role !== "participant" || link.state === "recreate") return link;
  if (link.state === "ok" && a.linkState === "review") {
    auth.setLink(a.id, "ok");
    auth.audit(SYSTEM_ACTOR, "account_restored", a, `numero ${a.participantId} e codice ${a.participantCode} di nuovo corrispondenti nei dati`);
    log?.info("Account di nuovo attivo: numero e codice corrispondono", { username: a.username });
  } else if (link.state !== "ok" && a.linkState === "ok") {
    auth.setLink(a.id, "review");
    const why =
      link.state === "relink"
        ? `il codice ${a.participantCode} nei dati ha ora il numero ${link.participantId}, non ${a.participantId}`
        : `il codice ${a.participantCode} non è più nei dati (numero ${a.participantId})`;
    auth.audit(SYSTEM_ACTOR, "account_flagged", a, why);
    log?.warn("Account da verificare: numero e codice del partecipante non corrispondono", { username: a.username });
  }
  return link;
}

/** the participant's view of a link: ok, «da verificare» or «da ricreare» */
export const linkView = (l: Link): "ok" | "review" | "recreate" => (l.state === "ok" ? "ok" : l.state === "recreate" ? "recreate" : "review");
