import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [{ url: 'https://boards.greenhouse.io/embed/job_board?for=stripe' }],
    keywordFilter = '',
    maxJobsPerBoard = 50,
} = input;

const TECH_KEYWORDS = [
    'Kubernetes', 'Terraform', 'AWS', 'GCP', 'Azure', 'Docker', 'Kafka', 'Snowflake',
    'Databricks', 'Spark', 'Airbyte', 'dbt', 'Postgres', 'ClickHouse', 'DuckDB',
    'Python', 'Golang', 'Rust', 'TypeScript', 'React', 'Next.js', 'Node.js', 'GraphQL',
    'PyTorch', 'vLLM', 'LangChain', 'LangGraph', 'OpenAI', 'Anthropic', 'RAG',
    'OpenTelemetry', 'Prometheus', 'Grafana', 'Datadog', 'Cilium', 'eBPF',
    'Salesforce', 'HubSpot', 'Stripe', 'Okta', 'SOC2', 'Zero Trust'
];

const SALARY_REGEX = /\$\s?\d{2,3}(?:,\d{3})+(?:\s?[-–—to]+\s?\$\s?\d{2,3}(?:,\d{3})+)?|\$\s?\d{2,3}[kK]\s?[-–—to]+\s?\$\s?\d{2,3}[kK]/g;

function detectAtsProvider(urlStr) {
    const u = urlStr.toLowerCase();
    if (u.includes('greenhouse.io')) return 'Greenhouse';
    if (u.includes('lever.co')) return 'Lever';
    if (u.includes('ashbyhq.com')) return 'Ashby';
    if (u.includes('workable.com')) return 'Workable';
    if (u.includes('myworkdayjobs.com')) return 'Workday';
    if (u.includes('bamboohr.com')) return 'BambooHR';
    return 'CareerPage / Schema.org';
}

function detectTechSignals(text) {
    if (!text) return [];
    const found = new Set();
    for (const kw of TECH_KEYWORDS) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
            found.add(kw);
        }
    }
    return [...found];
}

function detectWorkplaceType(text, locationStr) {
    const combined = `${text || ''} ${locationStr || ''}`.toLowerCase();
    if (combined.includes('remote')) return 'Remote';
    if (combined.includes('hybrid')) return 'Hybrid';
    return 'On-site';
}

function parseSalary(text) {
    if (!text) return null;
    const matches = text.match(SALARY_REGEX);
    return matches ? matches[0].trim() : null;
}

const filterRegex = keywordFilter ? new RegExp(keywordFilter, 'i') : null;

async function pushAndChargeJob(jobRecord) {
    if (filterRegex && !filterRegex.test(`${jobRecord.jobTitle} ${jobRecord.department || ''} ${jobRecord.location || ''}`)) {
        return false;
    }
    await Actor.pushData(jobRecord);
    try {
        if (typeof Actor.charge === 'function') {
            await Actor.charge({ eventName: 'job-scraped', count: 1 });
        }
    } catch (err) {
        log.debug(`PPE charge skipped in local environment: ${err.message}`);
    }
    return true;
}

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: startUrls.length * 5,
    async requestHandler({ request, $ }) {
        const currentUrl = request.loadedUrl || request.url;
        const atsProvider = detectAtsProvider(currentUrl);
        let jobsExtracted = 0;

        const pageTitle = $('title').first().text().trim();
        const defaultCompany = pageTitle.replace(/Jobs|Careers|Open Positions|at|-|\|/gi, '').trim() || new URL(currentUrl).hostname;

        // 1. Schema.org JobPosting JSON-LD extraction
        const schemaJobs = [];
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const parsed = JSON.parse($(el).contents().text().trim());
                const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
                while (queue.length > 0) {
                    const node = queue.shift();
                    if (!node || typeof node !== 'object') continue;
                    if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
                    const t = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
                    if (/JobPosting/i.test(t)) {
                        schemaJobs.push(node);
                    }
                }
            } catch {
                // Ignore invalid JSON-LD
            }
        });

        for (const sj of schemaJobs) {
            if (jobsExtracted >= maxJobsPerBoard) break;
            const descText = String(sj.description || '').replace(/<[^>]+>/g, ' ');
            const locObj = sj.jobLocation?.address || sj.jobLocation?.[0]?.address;
            const locStr = locObj
                ? [locObj.addressLocality, locObj.addressRegion, locObj.addressCountry].filter(Boolean).join(', ')
                : (typeof sj.jobLocation === 'string' ? sj.jobLocation : 'Unspecified');
            const baseSalary = sj.baseSalary?.value;
            const salaryRange = baseSalary
                ? {
                      min: baseSalary.minValue ?? baseSalary.value ?? null,
                      max: baseSalary.maxValue ?? baseSalary.value ?? null,
                      currency: sj.baseSalary?.currency || 'USD',
                  }
                : (parseSalary(descText) ? { raw: parseSalary(descText) } : null);

            const jobRecord = {
                companyName: sj.hiringOrganization?.name || defaultCompany,
                jobTitle: sj.title || 'Untitled Role',
                department: sj.occupationalCategory || sj.industry || null,
                location: locStr,
                workplaceType: sj.jobLocationType === 'TELECOMMUTE' ? 'Remote' : detectWorkplaceType(descText, locStr),
                employmentType: sj.employmentType || 'FULL_TIME',
                salaryRange,
                techStackSignals: detectTechSignals(descText),
                atsProvider,
                applyUrl: sj.url || currentUrl,
                postedAt: sj.datePosted || new Date().toISOString(),
                scrapedAt: new Date().toISOString(),
            };
            if (await pushAndChargeJob(jobRecord)) jobsExtracted++;
        }

        // 2. Greenhouse DOM Parser
        if (jobsExtracted === 0 && (atsProvider === 'Greenhouse' || $('.opening').length > 0)) {
            const openings = $('.opening').toArray();
            for (const el of openings) {
                if (jobsExtracted >= maxJobsPerBoard) break;
                const $el = $(el);
                const anchor = $el.find('a').first();
                const title = anchor.text().trim();
                const href = anchor.attr('href') || '';
                const location = $el.find('.location').text().trim() || 'Unspecified';
                const dept = $el.closest('section, .level-0').find('h2, h3').first().text().trim() || null;
                if (!title) continue;

                const applyUrl = href.startsWith('http') ? href : new URL(href, currentUrl).toString();
                const jobRecord = {
                    companyName: defaultCompany,
                    jobTitle: title,
                    department: dept,
                    location,
                    workplaceType: detectWorkplaceType(title, location),
                    employmentType: 'FULL_TIME',
                    salaryRange: null,
                    techStackSignals: detectTechSignals(`${title} ${dept || ''}`),
                    atsProvider: 'Greenhouse',
                    applyUrl,
                    postedAt: new Date().toISOString(),
                    scrapedAt: new Date().toISOString(),
                };
                if (await pushAndChargeJob(jobRecord)) jobsExtracted++;
            }
        }

        // 3. Lever DOM Parser
        if (jobsExtracted === 0 && (atsProvider === 'Lever' || $('.posting').length > 0)) {
            const postings = $('.posting').toArray();
            for (const el of postings) {
                if (jobsExtracted >= maxJobsPerBoard) break;
                const $el = $(el);
                const title = $el.find('[data-qa="posting-name"], h5').first().text().trim();
                const href = $el.find('a.posting-title, a').first().attr('href') || currentUrl;
                const location = $el.find('.sort-by-time, .location').first().text().trim() || 'Unspecified';
                const dept = $el.closest('.posting-group').find('.posting-category-title').first().text().trim() || null;
                const workplace = $el.find('.workplaceTypes').first().text().trim();
                if (!title) continue;

                const jobRecord = {
                    companyName: defaultCompany,
                    jobTitle: title,
                    department: dept,
                    location,
                    workplaceType: workplace || detectWorkplaceType(title, location),
                    employmentType: 'FULL_TIME',
                    salaryRange: null,
                    techStackSignals: detectTechSignals(`${title} ${dept || ''}`),
                    atsProvider: 'Lever',
                    applyUrl: href,
                    postedAt: new Date().toISOString(),
                    scrapedAt: new Date().toISOString(),
                };
                if (await pushAndChargeJob(jobRecord)) jobsExtracted++;
            }
        }

        // 4. Generic Career Links Fallback
        if (jobsExtracted === 0) {
            const links = $('a[href]').toArray();
            for (const el of links) {
                if (jobsExtracted >= maxJobsPerBoard) break;
                const $a = $(el);
                const href = ($a.attr('href') || '').trim();
                const text = $a.text().replace(/\s+/g, ' ').trim();
                if (
                    text.length >= 6 &&
                    text.length <= 100 &&
                    /\/(jobs?|careers?|positions?|openings?|roles?)\//i.test(href)
                ) {
                    const applyUrl = href.startsWith('http') ? href : new URL(href, currentUrl).toString();
                    const jobRecord = {
                        companyName: defaultCompany,
                        jobTitle: text,
                        department: null,
                        location: 'Unspecified',
                        workplaceType: detectWorkplaceType(text, ''),
                        employmentType: 'FULL_TIME',
                        salaryRange: null,
                        techStackSignals: detectTechSignals(text),
                        atsProvider,
                        applyUrl,
                        postedAt: new Date().toISOString(),
                        scrapedAt: new Date().toISOString(),
                    };
                    if (await pushAndChargeJob(jobRecord)) jobsExtracted++;
                }
            }
        }
    },
});

await crawler.run(startUrls);
await Actor.exit();
