/**
 * PA1 — legacy file ingestion.
 *
 * You are reading two files that a system you do not control exports for you:
 *
 *   data/orders-20260901.txt   fixed-width, CP1257 ("windows-1257")
 *   data/customers.csv         semicolon-separated, UTF-8
 *
 * Yes, two different encodings in one integration. That is not a trick I
 * invented; it is Tuesday.
 *
 * Everything you need is in the Node standard library. Do not add a parsing,
 * CSV or encoding dependency — feeling where these files fight back is the
 * entire point of the assignment, and a public test checks for it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- contract --
// The grader calls ingest() directly, with its own input files. Do not change
// its name, its parameters or the shape of what it returns. Everything else in
// this file is yours to restructure.

export interface Order {
  orderId: string;
  customerId: string;
  /** Correctly decoded and trimmed. "Bērziņš", never "B?rzi??". */
  customerName: string;
  /** ISO-8601 calendar date: "2026-09-01". */
  orderDate: string;
  /** Decimal STRING, never a number: "1234.56", "-250.00", "0.00". */
  amount: string;
  currency: string;
}

export interface RejectedRecord {
  /** 1-based line number in the orders file. */
  line: number;
  /** The offending line, as you decoded it. */
  raw: string;
  /** Why you rejected it, in plain language. */
  reason: string;
}

export interface Report {
  orders: Order[];
  rejected: RejectedRecord[];
  /** Customer ids that appear in the CSV but on no accepted order. */
  unmatchedCustomers: string[];
}

export interface IngestOptions {
  ordersPath: string;
  customersPath: string;
}

// ------------------------------------------------------------------ layout --
// The order file is fixed-width. Every field is LEFT-aligned and padded with
// trailing spaces. Slice by position — you cannot split on whitespace, because
// the names contain spaces.
//
//   field         columns (0-indexed, end exclusive)   width
//   orderId        0 .. 10                               10
//   customerId    10 .. 20                               10
//   customerName  20 .. 52                               32
//   orderDate     52 .. 62                               10   DD.MM.YYYY
//   amount        62 .. 74                               12   comma decimal
//   currency      74 .. 77                                3
//
// A well-formed line is exactly 77 characters.

export const ORDER_LAYOUT = {
  orderId: [0, 10],
  customerId: [10, 20],
  customerName: [20, 52],
  orderDate: [52, 62],
  amount: [62, 74],
  currency: [74, 77],
} as const;

export const ORDER_LINE_LENGTH = 77;

// ------------------------------------------------------------------- paths --
// Resolved from this file's own location, so the program behaves the same
// whichever directory you run it from.

const PA1_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_ORDERS_PATH = path.join(PA1_ROOT, "data", "orders-20260901.txt");
export const DEFAULT_CUSTOMERS_PATH = path.join(PA1_ROOT, "data", "customers.csv");
export const OUTPUT_PATH = path.join(PA1_ROOT, "out", "report.json");

// ------------------------------------------------------------------- steps --
// Suggested decomposition. Only ingest() is contractual — if you would rather
// structure this differently, do, and say why in your ADR.

/**
 * Turn the raw bytes of the order export into text.
 *
 * The file is CP1257. TextDecoder knows the label "windows-1257" natively —
 * no dependency needed.
 */
export function decodeOrderFile(bytes: Buffer): string {
  const decoder = new TextDecoder("windows-1257");
  return decoder.decode(bytes);
}

/**
 * "01.09.2026" -> "2026-09-01"
 *
 * Pure string surgery. Never routed through `new Date(...)`.
 */
export function toIsoDate(ddmmyyyy: string): string {
  const day = ddmmyyyy.slice(0, 2);
  const month = ddmmyyyy.slice(3, 5);
  const year = ddmmyyyy.slice(6, 10);
  return `${year}-${month}-${day}`;
}

/**
 * "1234,56" -> "1234.56"   "-250,00" -> "-250.00"   "0,00" -> "0.00"
 *
 * Returns a decimal STRING — never routed through parseFloat/Number.
 */
export function toDecimalString(amount: string): string {
  return amount.trim().replace(",", ".");
}

/**
 * Parse the semicolon-separated customer master into id -> full name.
 *
 * This file is UTF-8, unlike the order file. No field contains a semicolon
 * or a quote, so a simple split is enough — but the header row is skipped.
 */
export function parseCustomers(csv: string): Map<string, string> {
  const map = new Map<string, string>();

  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  // First line is the header: customerId;fullName;email;city
  const [, ...dataLines] = lines;

  for (const line of dataLines) {
    const parts = line.split(";");
    const customerId = parts[0];
    const fullName = parts[1];
    if (customerId) {
      map.set(customerId, fullName ?? "");
    }
  }

  return map;
}

// ------------------------------------------------------------------ ingest --

/**
 * Read both files and produce the report.
 */
export function ingest(options: IngestOptions): Report {
  const { ordersPath, customersPath } = options;

  const orders: Order[] = [];
  const rejected: RejectedRecord[] = [];
  const acceptedCustomerIds = new Set<string>();

  // Read as raw bytes first — reading this file as "utf8" directly is the
  // single most common way to lose marks on this assignment.
  const orderBytes = readFileSync(ordersPath);
  const orderText = decodeOrderFile(orderBytes);

  // Split into lines. Handle both LF and CRLF, and a possible trailing
  // newline producing an empty "phantom" final line.
  const rawLines = orderText.split(/\r?\n/);
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
      ? rawLines.slice(0, -1)
      : rawLines;

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1; // 1-based, matches the spec's example

    if (line.length !== ORDER_LINE_LENGTH) {
      rejected.push({
        line: lineNumber,
        raw: line,
        reason: `expected ${ORDER_LINE_LENGTH} characters, got ${line.length}`,
      });
      return;
    }

    const orderId = line.slice(...ORDER_LAYOUT.orderId).trimEnd();
    const customerId = line.slice(...ORDER_LAYOUT.customerId).trimEnd();
    const customerName = line.slice(...ORDER_LAYOUT.customerName).trimEnd();
    const rawDate = line.slice(...ORDER_LAYOUT.orderDate).trimEnd();
    const rawAmount = line.slice(...ORDER_LAYOUT.amount).trimEnd();
    const currency = line.slice(...ORDER_LAYOUT.currency).trimEnd();

    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(rawDate)) {
      rejected.push({
        line: lineNumber,
        raw: line,
        reason: `invalid date format: "${rawDate}"`,
      });
      return;
    }

    orders.push({
      orderId,
      customerId,
      customerName,
      orderDate: toIsoDate(rawDate),
      amount: toDecimalString(rawAmount),
      currency,
    });
    acceptedCustomerIds.add(customerId);
  });

  // Customer master is UTF-8, unlike the order file.
  const customerText = readFileSync(customersPath, "utf8");
  const customers = parseCustomers(customerText);

  const unmatchedCustomers: string[] = [];
  for (const customerId of customers.keys()) {
    if (!acceptedCustomerIds.has(customerId)) {
      unmatchedCustomers.push(customerId);
    }
  }

  return { orders, rejected, unmatchedCustomers };
}

// -------------------------------------------------------------------- main --

/** Writes the report to pa1/out/report.json. Run with: npm start */
export function main(): void {
  const report = ingest({
    ordersPath: DEFAULT_ORDERS_PATH,
    customersPath: DEFAULT_CUSTOMERS_PATH,
  });

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(
    `wrote ${OUTPUT_PATH}\n` +
      `  ${report.orders.length} orders\n` +
      `  ${report.rejected.length} rejected\n` +
      `  ${report.unmatchedCustomers.length} customers with no order`,
  );
}

// Only run main() when this file is executed directly, not when it is imported
// by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}