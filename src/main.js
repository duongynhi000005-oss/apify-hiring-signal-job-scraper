import { Actor } from 'apify';
import * as cheerio from 'cheerio';

await Actor.init();

const input = (await Actor.getInput()) || {};
const startUrls = Array.isArray(input.startUrls) && input.startUrls.length > 0
    ? input.startUrls
    : [{ url: 'https://apify.com/careers' }];

const TECH_SKILLS = [
    'Python', 'TypeScript', 'JavaScript', 'Rust', 'Go', 'Golang', 'Java', 'C++', 'React', 'Next.js',
    'Node.js', 'Kubernetes', 'Docker', 'AWS', 'GCP', 'Azure', 'Terraform', 'Postgres', 'PostgreSQL',
    'Snowflake', 'Databricks', 'Spark', 'Kafka', 'PyTorch', 'LLM', 'RAG', 'GraphQL', 'HubSpot', 'Salesforce'
];

for (const item of startUrls) {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    if (!rawUrl) continue;
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' }
        });
        const html = await res.text();
        const $ = cheerio.load(html);

        let atsPlatform = 'Custom Career Page';
        if (/greenhouse\.io/i.test(html) || /greenhouse\.io/i.test(url)) atsPlatform = 'Greenhouse';
        else if (/lever\.co/i.test(html) || /lever\.co/i.test(url)) atsPlatform = 'Lever';
        else if (/ashbyhq\.com/i.test(html) || /ashbyhq\.com/i.test(url)) atsPlatform = 'Ashby';
        else if (/workable\.com/i.test(html)) atsPlatform = 'Workable';
        else if (/smartrecruiters\.com/i.test(html)) atsPlatform = 'SmartRecruiters';
        else if (/myworkdayjobs\.com/i.test(html)) atsPlatform = 'Workday';

        const jobs = [];
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const parsed = JSON.parse($(el).html() || '{}');
                const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
                for (const n of nodes) {
                    if (n && n['@type'] === 'JobPosting') {
                        jobs.push({
                            title: n.title,
                            department: n.occupationalCategory || n.industry || 'General',
                            employmentType: n.employmentType || 'FULL_TIME',
                            location: n.jobLocation?.address?.addressLocality || (n.jobLocationType === 'TELECOMMUTE' ? 'Remote' : 'On-site'),
                            url: n.url || url,
                            datePosted: n.datePosted || null
                        });
                    }
                }
            } catch {}
        });

        $('a[href]').each((_, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            const href = $(el).attr('href') || '';
            if (
                text.length >= 4 &&
                text.length <= 100 &&
                (/\/(jobs?|careers?|positions?|openings?|roles?)\//i.test(href) ||
                 /\b(Engineer|Developer|Manager|Designer|Director|Analyst|Account Executive|Recruiter|Scientist|Architect|Counsel|Marketing|Sales)\b/i.test(text))
            ) {
                try {
                    const fullUrl = new URL(href, url).href;
                    if (!jobs.some((j) => j.url === fullUrl || j.title === text)) {
                        jobs.push({
                            title: text,
                            department: /Engineer|Developer|Architect|SRE|DevOps|Data|AI/i.test(text) ? 'Engineering & AI'
                                : /Sales|Account|Revenue|BDR|SDR/i.test(text) ? 'Sales & GTM'
                                : /Marketing|Growth|Brand/i.test(text) ? 'Marketing'
                                : 'Operations & General',
                            location: /remote/i.test(text) ? 'Remote' : 'Flexible / Hybrid',
                            url: fullUrl
                        });
                    }
                } catch {}
            }
        });

        const detectedTechSkills = TECH_SKILLS.filter((skill) =>
            new RegExp(`\\b${skill.replace(/[+.#]/g, '\\$&')}\\b`, 'i').test(html)
        );
        const salaryMatches = html.match(/\$\d{2,3}(?:,\d{3})+(?:\s*[-–—]\s*\$\d{2,3}(?:,\d{3})+)?|\$\d{2,3}k\s*[-–—]\s*\$\d{2,3}k/gi) || [];

        const hiringVelocityScore = Math.min(100, jobs.length * 8 + detectedTechSkills.length * 4 + (atsPlatform !== 'Custom Career Page' ? 20 : 10));

        await Actor.pushData({
            url,
            pageTitle: $('title').first().text().trim() || url,
            atsPlatform,
            hiringVelocityScore,
            hiringSignalTier: hiringVelocityScore >= 60 ? 'HIGH_GROWTH_BUYING_INTENT' : hiringVelocityScore >= 25 ? 'ACTIVE_HIRING' : 'LOW_HIRING',
            openRolesCount: jobs.length,
            detectedTechStackSignals: detectedTechSkills,
            salaryRangesFound: Array.from(new Set(salaryMatches)).slice(0, 10),
            jobs: jobs.slice(0, 60),
            scrapedAt: new Date().toISOString()
        });
    } catch (err) {
        await Actor.pushData({ url, error: err.message, scrapedAt: new Date().toISOString() });
    }
}

await Actor.exit();
