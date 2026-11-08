"use client";

import { useState } from "react";

import { GRADES, NEXT_STEPS, SHARE_OPTIONS } from "@/components/seminar/content";
import { SurveyThanks } from "@/components/seminar/SeminarShell";
import { ActionButton } from "@/components/ui/ActionButton";
import { errorMessage, sendJson } from "@/components/users/api";
import type {
  SeminarGrade,
  SeminarNextStep,
  SeminarShare,
  SeminarSurveySubmitResult,
} from "@/types";
import { useAction } from "@/lib/use-action";

const RATINGS = [1, 2, 3, 4, 5] as const;

const fieldset = "flex flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const legend = "px-1 text-sm font-medium";
const choice = "flex items-start gap-2 text-sm";

/**
 * The seminar survey behind a personal WhatsApp link (`/survey/<token>`).
 *
 * The token is posted with the answers and never rendered into the page: it is
 * what ties these answers to the chat the link was sent to. The server is the
 * authority on validation; the local checks only save a round trip.
 */
export function SurveyForm({ token }: { token: string }) {
  const [rating, setRating] = useState<number | null>(null);
  const [grades, setGrades] = useState<SeminarGrade[]>([]);
  const [comment, setComment] = useState("");
  const [share, setShare] = useState<SeminarShare | null>(null);
  const [nextStep, setNextStep] = useState<SeminarNextStep | null>(null);
  const [name, setName] = useState("");
  const [stayInTouch, setStayInTouch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function toggleGrade(grade: SeminarGrade) {
    setGrades((current) =>
      current.includes(grade) ? current.filter((g) => g !== grade) : [...current, grade],
    );
  }

  // One submit at a time: a double tap or a second Enter lands before the
  // disabled button renders, so the lock — not `disabled` — stops the repost.
  const send = useAction(async () => {
    setError(null);
    if (rating === null) {
      setError("請為講座評分 Please rate the seminar.");
      return;
    }
    if (grades.length === 0) {
      setError("請選擇孩子就讀的年級 Please choose your child's grade.");
      return;
    }
    if (share === null || nextStep === null || !name.trim()) {
      setError("請填寫所有必填項目 Please answer every required question.");
      return;
    }
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
    void send.run();
  }

  if (done) return <SurveyThanks />;

  return (
    <form
      data-component="SurveyForm"
      onSubmit={submit}
      aria-busy={busy}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-[var(--color-muted)]">
        感謝您出席講座，問卷只需約1分鐘。完成後，我們會在 WhatsApp 傳送講座簡報給您。
        <br />
        Thank you for joining — this takes about 1 minute. Once you finish,
        we&apos;ll send the presentation slides to you on WhatsApp.
      </p>

      <fieldset className={fieldset}>
        <legend className={legend}>
          今天的講座對您有多大幫助？ How helpful was today&apos;s seminar? *
        </legend>
        <div className="flex justify-between gap-2">
          {RATINGS.map((value) => (
            <label key={value} className="flex flex-1 flex-col items-center gap-1 text-sm">
              <input
                type="radio"
                name="rating"
                value={value}
                checked={rating === value}
                onChange={() => setRating(value)}
                required
              />
              {value}
            </label>
          ))}
        </div>
        <div className="flex justify-between text-xs text-[var(--color-muted)]">
          <span>沒有幫助 Not helpful</span>
          <span>非常有幫助 Very helpful</span>
        </div>
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>
          您的孩子就讀哪個年級？ Which grade is your child in? *
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {GRADES.map((grade) => (
            <label key={grade.value} className={choice}>
              <input
                type="checkbox"
                name="grades"
                value={grade.value}
                checked={grades.includes(grade.value)}
                onChange={() => toggleGrade(grade.value)}
              />
              {grade.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>
          如果向其他家長介紹今天的講座，您會怎樣說？ In a sentence or two, what would
          you tell another parent about today&apos;s seminar?
        </legend>
        <textarea
          name="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="例如：最有用的一點，或您會在家嘗試的方法 e.g. the most useful idea, or one thing you'll try at home"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm"
        />
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>
          我們可否在網站及社交媒體分享您的意見？ May we share your comment on our
          website and social media? *
        </legend>
        {SHARE_OPTIONS.map((option) => (
          <label key={option.value} className={choice}>
            <input
              type="radio"
              name="share"
              value={option.value}
              checked={share === option.value}
              onChange={() => setShare(option.value)}
              required
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>
          您希望與 AI&amp;I 進一步做甚麼？ What would you like to do next with AI&amp;I? *
        </legend>
        {NEXT_STEPS.map((option) => (
          <label key={option.value} className={choice}>
            <input
              type="radio"
              name="next_step"
              value={option.value}
              checked={nextStep === option.value}
              onChange={() => setNextStep(option.value)}
              required
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>姓名 Name *</legend>
        <input
          type="text"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          autoComplete="name"
          required
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm"
        />
      </fieldset>

      <fieldset className={fieldset}>
        <legend className={legend}>保持聯絡 Stay in touch</legend>
        <label className={choice}>
          <input
            type="checkbox"
            name="stay_in_touch"
            checked={stayInTouch}
            onChange={(e) => setStayInTouch(e.target.checked)}
          />
          我同意 AI&amp;I 透過 WhatsApp／電郵通知我日後的課程及工作坊。 Yes, AI&amp;I may
          contact me by WhatsApp / email about future classes and workshops.
        </label>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <ActionButton
        type="submit"
        busy={busy}
        busyLabel="提交中… Submitting…"
        className="rounded-xl bg-[var(--color-accent)] px-4 py-3 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
      >
        提交並索取簡報 Submit &amp; get the slides
      </ActionButton>
    </form>
  );
}
