"use client";

import { useRef, useState, type ReactNode } from "react";

import { GRADES, NEXT_STEPS, SHARE_OPTIONS } from "@/components/seminar/content";
import { SurveyThanks } from "@/components/seminar/SeminarShell";
import { ActionButton } from "@/components/ui/ActionButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { errorMessage, sendJson } from "@/components/users/api";
import type {
  SeminarGrade,
  SeminarNextStep,
  SeminarShare,
  SeminarSurveySubmitResult,
} from "@/types";
import { useAction } from "@/lib/use-action";

const RATINGS = [1, 2, 3, 4, 5] as const;

/** The questions the server requires, in page order (`validate_answers`). */
type Field = "rating" | "grades" | "share" | "next_step" | "name";

const MISSING: Record<Field, string> = {
  rating: "請為講座評分。Please rate the seminar.",
  grades: "請選擇孩子就讀的年級。Please choose your child's grade.",
  share: "請選擇可否分享您的意見。Please tell us whether we may share your comment.",
  next_step: "請選擇您希望進一步做甚麼。Please choose what you'd like to do next.",
  name: "請填寫您的姓名。Please enter your name.",
};

const field = "min-h-11 w-full rounded-[var(--radius-lg)] border bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)]";
const choiceRow = "flex min-h-8 cursor-pointer items-center gap-3 text-sm";
const nativeChoice = "size-5 shrink-0 accent-[var(--color-accent)]";

/** One question card (Figma survey card): Chinese label, English helper, answer. */
function Question({
  id,
  zh,
  en,
  invalid = false,
  children,
  footer,
}: {
  id: string;
  zh: ReactNode;
  en: ReactNode;
  invalid?: boolean;
  children: ReactNode;
  /** Rendered after the "Required" hint, e.g. an optional extra choice. */
  footer?: ReactNode;
}) {
  return (
    <section
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
      data-invalid={invalid ? "true" : undefined}
      className={`flex min-w-0 flex-col gap-3 rounded-[var(--radius-xl)] border bg-[var(--color-surface)] p-5 ${
        invalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)]"
      }`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-label`} className="text-sm font-semibold">
          {zh}
        </h2>
        <p id={`${id}-help`} className="text-sm text-[var(--color-muted)]">
          {en}
        </p>
      </div>
      {children}
      {invalid ? (
        <p id={`${id}-error`} className="text-xs text-[var(--color-danger)]">
          請填寫 Required
        </p>
      ) : null}
      {footer}
    </section>
  );
}

/**
 * The seminar survey behind a personal WhatsApp link (`/survey/<token>`),
 * laid out as Figma "survey" (23:2515 / 23:2605).
 *
 * The token is posted with the answers and never rendered into the page: it is
 * what ties these answers to the chat the link was sent to. The server is the
 * authority on validation; the local checks only save a round trip and point
 * at the first unanswered question.
 */
export function SurveyForm({ token }: { token: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [grades, setGrades] = useState<SeminarGrade[]>([]);
  const [comment, setComment] = useState("");
  const [share, setShare] = useState<SeminarShare | null>(null);
  const [nextStep, setNextStep] = useState<SeminarNextStep | null>(null);
  const [name, setName] = useState("");
  const [stayInTouch, setStayInTouch] = useState(false);
  const [missing, setMissing] = useState<Field[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function answered(f: Field) {
    setMissing((current) => current.filter((m) => m !== f));
  }

  function toggleGrade(grade: SeminarGrade) {
    setGrades((current) =>
      current.includes(grade) ? current.filter((g) => g !== grade) : [...current, grade],
    );
    answered("grades");
  }

  // Checked before the submit lock: while sending, the fieldset is disabled,
  // and focusing a question inside it would drop focus to the page.
  function validate(): boolean {
    setError(null);
    const empty: Field[] = [];
    if (rating === null) empty.push("rating");
    if (grades.length === 0) empty.push("grades");
    if (share === null) empty.push("share");
    if (nextStep === null) empty.push("next_step");
    if (!name.trim()) empty.push("name");
    setMissing(empty);
    if (empty.length > 0) {
      setError(empty.length === 1 ? MISSING[empty[0]] : `${MISSING[empty[0]]} 請填寫所有必填項目。Please answer every required question.`);
      formRef.current?.querySelector<HTMLInputElement>(`input[name="${empty[0]}"]`)?.focus();
      return false;
    }
    return true;
  }

  // One submit at a time: a double tap or a second Enter lands before the
  // disabled button renders, so the lock — not `disabled` — stops the repost.
  const send = useAction(async () => {
    setError(null);
    try {
      await sendJson<SeminarSurveySubmitResult>("/api/seminar/survey/submit", "POST", {
        token,
        answers: {
          rating,
          grades,
          comment,
          share,
          next_step: nextStep,
          name,
          stay_in_touch: stayInTouch,
        },
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, "未能提交，請再試一次。 Couldn't submit — please try again."));
    }
  });
  const busy = send.pending;

  function submit(evt: React.FormEvent) {
    evt.preventDefault();
    if (send.pending || !validate()) return;
    void send.run();
  }

  if (done) return <SurveyThanks />;

  const invalid = (f: Field) => missing.includes(f);

  return (
    <form
      ref={formRef}
      data-component="SurveyForm"
      onSubmit={submit}
      aria-busy={busy}
      noValidate
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-[var(--color-muted)]">
        問卷只需約1分鐘，完成後我們會在 WhatsApp 傳送講座簡報給您。* 為必填。
        <br />
        This takes about 1 minute. Once you finish, we&apos;ll send the slides to you on
        WhatsApp. * means required.
      </p>

      {/* Every answer is read-only while the submit is in flight. */}
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <Question
          id="survey-rating"
          zh="今天的講座對您有多大幫助？ *"
          en={<>How helpful was today&apos;s seminar? (1 = not helpful, 5 = very helpful) *</>}
          invalid={invalid("rating")}
        >
          <div className="grid grid-cols-5 gap-2">
            {RATINGS.map((value) => (
              <label key={value} className="min-w-0 cursor-pointer">
                <input
                  type="radio"
                  name="rating"
                  value={value}
                  checked={rating === value}
                  onChange={() => {
                    setRating(value);
                    answered("rating");
                  }}
                  className="peer sr-only"
                />
                <span
                  className={`flex min-h-11 items-center justify-center rounded-[var(--radius-lg)] border text-sm font-semibold peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent)] ${
                    rating === value
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-accent)]"
                  }`}
                >
                  {value}
                </span>
              </label>
            ))}
          </div>
        </Question>

        <Question
          id="survey-grades"
          zh="您的孩子就讀哪個年級？（可選多項） *"
          en="Which grade is your child in? (choose any) *"
          invalid={invalid("grades")}
        >
          <div className="flex flex-wrap gap-2">
            {GRADES.map((grade) => {
              const on = grades.includes(grade.value);
              return (
                <label key={grade.value} className="cursor-pointer">
                  <input
                    type="checkbox"
                    name="grades"
                    value={grade.value}
                    checked={on}
                    onChange={() => toggleGrade(grade.value)}
                    className="peer sr-only"
                  />
                  <span
                    className={`inline-flex min-h-9 items-center gap-1 rounded-[var(--radius-full)] border px-3 text-sm peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent)] ${
                      on
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    {on ? <span aria-hidden="true">✓</span> : null}
                    {grade.label}
                  </span>
                </label>
              );
            })}
          </div>
        </Question>

        <Question
          id="survey-comment"
          zh="如果向其他家長介紹今天的講座，您會怎樣說？"
          en={<>In a sentence or two, what would you tell another parent about today&apos;s seminar?</>}
        >
          <textarea
            name="comment"
            aria-labelledby="survey-comment-label"
            aria-describedby="survey-comment-help"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="例如：最有用的一點，或您會在家嘗試的方法 e.g. the most useful idea, or one thing you'll try at home"
            className={`${field} border-[var(--color-border)] py-3`}
          />
        </Question>

        <Question
          id="survey-share"
          zh="我們可否在網站及社交媒體分享您的意見？ *"
          en="May we share your comment on our website and social media? *"
          invalid={invalid("share")}
        >
          <div className="flex flex-col gap-2">
            {SHARE_OPTIONS.map((option) => (
              <label key={option.value} className={choiceRow}>
                <input
                  type="radio"
                  name="share"
                  value={option.value}
                  checked={share === option.value}
                  onChange={() => {
                    setShare(option.value);
                    answered("share");
                  }}
                  className={nativeChoice}
                />
                <span className="min-w-0">{option.label}</span>
              </label>
            ))}
          </div>
        </Question>

        <Question
          id="survey-next"
          zh="您希望與 AI&I 進一步做甚麼？ *"
          en="What would you like to do next with AI&I? *"
          invalid={invalid("next_step")}
        >
          <div className="flex flex-col gap-2">
            {NEXT_STEPS.map((option) => (
              <label key={option.value} className={choiceRow}>
                <input
                  type="radio"
                  name="next_step"
                  value={option.value}
                  checked={nextStep === option.value}
                  onChange={() => {
                    setNextStep(option.value);
                    answered("next_step");
                  }}
                  className={nativeChoice}
                />
                <span className="min-w-0">{option.label}</span>
              </label>
            ))}
          </div>
        </Question>

        <Question
          id="survey-name"
          zh="姓名 *"
          en="Name *"
          invalid={invalid("name")}
          footer={
            <label className={`${choiceRow} items-start`}>
              <input
                type="checkbox"
                name="stay_in_touch"
                checked={stayInTouch}
                onChange={(e) => setStayInTouch(e.target.checked)}
                className={`${nativeChoice} mt-0.5`}
              />
              <span className="min-w-0">
                <span className="font-medium">保持聯絡 Stay in touch</span>
                <span className="block text-[var(--color-muted)]">
                  我同意 AI&amp;I 透過 WhatsApp／電郵通知我日後的課程及工作坊。 Yes, AI&amp;I may
                  contact me by WhatsApp / email about future classes and workshops.
                </span>
              </span>
            </label>
          }
        >
          <input
            type="text"
            name="name"
            aria-labelledby="survey-name-label"
            aria-describedby={`survey-name-help${invalid("name") ? " survey-name-error" : ""}`}
            aria-invalid={invalid("name") || undefined}
            aria-required="true"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) answered("name");
            }}
            maxLength={100}
            autoComplete="name"
            className={`${field} ${invalid("name") ? "border-[var(--color-danger)]" : "border-[var(--color-border)]"}`}
          />
        </Question>
      </fieldset>

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      <div className="flex flex-col gap-2">
        <ActionButton
          type="submit"
          busy={busy}
          busyLabel="提交中… Submitting…"
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          提交並索取簡報 Submit &amp; get the slides
        </ActionButton>
        {busy ? (
          <p className="text-xs text-[var(--color-muted)]">
            傳送期間答案不能修改。All answers are read-only while sending.
          </p>
        ) : null}
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        您的答案只用於改善講座、傳送簡報，以及您在上面同意的用途。 We only use your answers
        to improve the seminar, send you the slides, and for what you agreed to above.
      </p>
    </form>
  );
}
