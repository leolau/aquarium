import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SeminarShell, SurveyThanks } from "@/components/seminar/SeminarShell";
import { SurveyForm } from "@/components/seminar/SurveyForm";

const TOKEN = "personal-survey-token-value";

describe("SurveyForm", () => {
  const html = renderToStaticMarkup(<SurveyForm token={TOKEN} />);

  it("asks every Google Form question in Chinese and English", () => {
    expect(html).toContain('data-component="SurveyForm"');
    for (const text of [
      "今天的講座對您有多大幫助？",
      "How helpful was today&#x27;s seminar?",
      "您的孩子就讀哪個年級？",
      "Which grade is your child in?",
      "我們可否在網站及社交媒體分享您的意見？",
      "What would you like to do next with AI&amp;I?",
      "姓名 *",
      "Name *",
      "保持聯絡 Stay in touch",
      "提交並索取簡報 Submit &amp; get the slides",
    ]) {
      expect(html).toContain(text);
    }
    expect(html.match(/name="rating"/g)).toHaveLength(5);
    expect(html.match(/name="grades"/g)).toHaveLength(6);
  });

  it("never renders the token into the page", () => {
    expect(html).not.toContain(TOKEN);
  });
});

describe("SeminarShell", () => {
  it("shows the AI&I mark, the survey line and a bilingual thank-you", () => {
    const html = renderToStaticMarkup(
      <SeminarShell>
        <SurveyThanks />
      </SeminarShell>,
    );
    expect(html).toContain('src="/seminar/ai-and-i-logo.jpg"');
    expect(html).toContain("AI&amp;I Seminar");
    expect(html).toContain("講座問卷 Survey");
    expect(html).not.toContain("Aquarium");
    expect(html).toContain("多謝您完成問卷");
    expect(html).toContain("Thank you for completing the survey");
  });
});
