
/**
 * Generates a Google Calendar "Add Event" URL
 * 
 * @param title Event title
 * @param dateStr Date in YYYY-MM-DD format
 * @param timeStr Time string (e.g., "4:45 PM")
 * @param location Event location
 * @param description Event description
 * @returns Google Calendar URL
 */
export function generateGoogleCalendarUrl(
    title: string,
    dateStr: string,
    timeStr: string,
    location?: string,
    description?: string
): string | null {
    if (!dateStr) return null;

    try {
        // Parse Date and Time
        const dateParts = dateStr.split('-');
        if (dateParts.length !== 3) return null;

        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1; // Month is 0-indexed
        const day = parseInt(dateParts[2]);

        let hour = 12; // Default to noon if time parsing fails
        let minute = 0;

        if (timeStr) {
            const timeParts = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
            if (timeParts) {
                let h = parseInt(timeParts[1]);
                const m = parseInt(timeParts[2]);
                const amp = timeParts[3]?.toUpperCase();

                if (amp === 'PM' && h < 12) h += 12;
                if (amp === 'AM' && h === 12) h = 0;

                hour = h;
                minute = m;
            }
        }

        const startDate = new Date(year, month, day, hour, minute);
        const endDate = new Date(startDate.getTime() + (60 * 60 * 1000)); // Default 1 hour duration

        // Format dates as YYYYMMDDTHHmmSSZ (UTC) for Google
        // Actually, easier to use local time format YYYYMMDDTHHmmSS if we don't convert to UTC
        // But Google prefers UTC. Let's send in local time format without Z, Google will assume user's timezone or we can specify `ctz`.

        const formatDateTime = (date: Date) => {
            return date.toISOString().replace(/-|:|\.\d\d\d/g, "");
        };

        // Note: toISOString returns UTC. If the user input "4:45 PM" they usually mean local time.
        // If we construct `new Date(year, month, day...)` it uses the browser's local timezone.
        // `toISOString` then converts that local time to UTC.
        // This is generally correct for Google Calendar which expects UTC if 'Z' is present.

        const start = formatDateTime(startDate);
        const end = formatDateTime(endDate);

        const baseUrl = "https://calendar.google.com/calendar/render";
        const params = new URLSearchParams({
            action: "TEMPLATE",
            text: title,
            dates: `${start}/${end}`,
            details: description || "",
            location: location || "",
            sf: "true",
            output: "xml"
        });

        return `${baseUrl}?${params.toString()}`;
    } catch (e) {
        console.error("Error generating calendar URL", e);
        return null;
    }
}
