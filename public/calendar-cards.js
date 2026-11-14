const japanTime = { timeZone: "Asia/Tokyo" };
export function calendarEventText(event) {
  if (event.allDay) {
    const lastDay = new Date(Date.parse(event.end.date) - 86400000)
      .toISOString()
      .slice(0, 10);
    return event.start.date === lastDay
      ? `${event.start.date}・終日`
      : `${event.start.date}〜${lastDay}・終日`;
  }
  const format = (value) =>
    new Date(value).toLocaleString("ja-JP", {
      ...japanTime,
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${format(event.start.dateTime)}〜${format(event.end.dateTime)}`;
}
export function createCalendarCard(event) {
  const row = document.createElement("article");
  row.className = "calendar-event";
  const title = document.createElement("h3"),
    when = document.createElement("p"),
    source = document.createElement("p");
  title.textContent = event.title;
  when.className = "calendar-event-time";
  when.textContent = calendarEventText(event) + "（日本時間）";
  source.className = "home-item-meta";
  source.textContent = [
    event.label || event.email,
    event.location,
    event.tentative ? "未確定" : "",
    event.transparent ? "空き時間として扱う" : "",
    event.stale || event.cachedWithError ? "保存済み・最新とは限りません" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  row.append(when, title, source);
  if (event.url) {
    try {
      const url = new URL(event.url);
      if (
        url.protocol === "https:" &&
        ["calendar.google.com", "www.google.com"].includes(url.hostname)
      ) {
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "カレンダーで確認 ↗";
        row.append(link);
      }
    } catch {
      /* 不正な外部リンクは表示しない。日時と名称は確認できる。 */
    }
  }
  return row;
}
