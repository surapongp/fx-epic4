using Exim.Fx.Forward;
using Microsoft.OpenApi;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------
//  Swagger / OpenAPI
// ---------------------------------------------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(o =>
{
    o.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Forward v2 — Tenor Calculator API",
        Version = "v1",
        Description = "API คำนวณ Tenor รายเดือนของสัญญา FX Forward (พอร์ตจากหน้าจอ Forward v2)",
    });
});

// ---------------------------------------------------------------------------
//  CORS — เปิดให้ทุก origin เรียกได้ (mockup); ปรับ WithOrigins(...) ตอนใช้จริง
// ---------------------------------------------------------------------------
const string CorsPolicy = "ForwardV2Cors";
builder.Services.AddCors(options =>
{
    options.AddPolicy(CorsPolicy, policy =>
    {
        var allowed = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>();
        if (allowed is { Length: > 0 })
            policy.WithOrigins(allowed).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
        else
            policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
    });
});

// ---------------------------------------------------------------------------
//  Market data (mock in-memory — ตรงกับค่า mockup ในไฟล์ต้นฉบับ Forward v2)
//  ในระบบจริงให้เปลี่ยนเป็น class ที่สืบทอด ForwardV2MarketData แล้วดึงจาก DB
// ---------------------------------------------------------------------------
builder.Services.AddSingleton<ForwardV2MarketData>(_ => new InMemoryForwardV2MarketData(
    // spot rate (mid) — ค่าเดียวกับ sim (M.rates[ccy].spot) ในหน้าจอ Forward v2
    spot: new()
    {
        ["USD"] = 36.42m, ["EUR"] = 39.68m, ["GBP"] = 46.12m,
        ["JPY"] = 0.2438m, ["CNY"] = 5.02m, ["SGD"] = 27.15m,
    },
    // swap point (master) M1..M6 — ค่าเดียวกับ sim (M.rates[ccy].sw) · เก็บเป็นค่าติดลบตามต้นฉบับ
    // ฝั่งขาย (sell) จะถูก Math.Abs ให้เป็นบวกอัตโนมัติใน GetSwapPoint(...,side) — ตรงกับ fwd2Sw
    swapPointsByTenor: new()
    {
        ["USD"] = new[] { -0.08m, -0.16m, -0.23m, -0.31m, -0.39m, -0.46m },
        ["EUR"] = new[] { -0.05m, -0.11m, -0.17m, -0.24m, -0.30m, -0.37m },
        ["GBP"] = new[] { -0.10m, -0.21m, -0.31m, -0.42m, -0.52m, -0.63m },
        ["JPY"] = new[] { -0.0012m, -0.0024m, -0.0036m, -0.0048m, -0.0060m, -0.0072m },
        ["CNY"] = new[] { -0.02m, -0.04m, -0.06m, -0.08m, -0.10m, -0.12m },
        ["SGD"] = new[] { -0.03m, -0.07m, -0.10m, -0.14m, -0.17m, -0.21m },
    },
    // วันหยุดไทย (ใช้ทุกสกุล) — ใส่ตัวอย่าง สงกรานต์ 2026
    thaiHolidays: new List<DateOnly>
    {
        new(2026, 4, 13), new(2026, 4, 14), new(2026, 4, 15),
    },
    // วันหยุดเฉพาะสกุล (ตรงกับ FWD2_HOL_CCY ในไฟล์ต้นฉบับ)
    currencyHolidays: new()
    {
        ["USD"] = new() { new(2026,1,19), new(2026,2,16), new(2026,5,25), new(2026,7,3), new(2026,9,7), new(2026,11,26), new(2026,12,25) },
        ["EUR"] = new() { new(2026,4,3), new(2026,4,6), new(2026,5,1), new(2026,12,25), new(2026,12,26) },
        ["GBP"] = new() { new(2026,4,3), new(2026,4,6), new(2026,5,4), new(2026,5,25), new(2026,8,31), new(2026,12,25), new(2026,12,28) },
        ["JPY"] = new() { new(2026,2,11), new(2026,2,23), new(2026,4,29), new(2026,5,4), new(2026,5,5), new(2026,11,23) },
        ["CNY"] = new() { new(2026,2,16), new(2026,2,17), new(2026,2,18), new(2026,5,1), new(2026,10,1), new(2026,10,2) },
        ["SGD"] = new() { new(2026,2,17), new(2026,5,1), new(2026,8,10), new(2026,12,25) },
    }));

builder.Services.AddScoped<ForwardV2TenorCalculator>();

var app = builder.Build();

// Swagger UI ที่ /swagger (เปิดทุก environment เพื่อความสะดวกใน mockup)
app.UseSwagger();
app.UseSwaggerUI(o =>
{
    o.SwaggerEndpoint("/swagger/v1/swagger.json", "Forward v2 API v1");
    o.RoutePrefix = "swagger";
});

app.UseCors(CorsPolicy);

// helper: แปลง string → Side (รับ "buy"/"sell" ไม่สนตัวพิมพ์)
static ForwardV2TenorCalculator.Side ParseSide(string? s) =>
    string.Equals(s, "buy", StringComparison.OrdinalIgnoreCase)
        ? ForwardV2TenorCalculator.Side.Buy
        : ForwardV2TenorCalculator.Side.Sell;

var api = app.MapGroup("/api/forward-v2");

// ราก: อธิบาย endpoint ที่มี
app.MapGet("/", () => Results.Ok(new
{
    service = "Forward v2 — Tenor Calculator API",
    endpoints = new[]
    {
        "GET /api/forward-v2/spot-info?tradeDate=2026-01-28",
        "GET /api/forward-v2/max-end?tradeDate=2026-01-28",
        "GET /api/forward-v2/tenors?tradeDate=2026-01-28&ccy=USD",
        "GET /api/forward-v2/validate-end?tradeDate=2026-01-28&tenor=3&ccy=USD&endDate=2026-04-20",
        "GET /api/forward-v2/schedule?tradeDate=2026-01-28&endDate=2026-05-15&ccy=USD&side=sell&includeDaily=false",
    }
}));

// Spot value date (T+2 วันทำการไทย) + flag EOM
api.MapGet("/spot-info", (DateOnly tradeDate, ForwardV2TenorCalculator calc) =>
{
    var si = calc.GetSpotInfo(tradeDate);
    return Results.Ok(new { tradeDate, spotValueDate = si.SpotValueDate, isEndOfMonth = si.IsEndOfMonth });
})
.WithName("GetSpotInfo")
.WithSummary("Spot value date (T+2) + EOM")
.WithDescription("คืน Spot value date (T+2 วันทำการไทย) และ flag ว่าเป็นวันทำการสุดท้ายของเดือน (EOM)");

// วันสิ้นสุดสัญญาสูงสุด = spot + 6 เดือน
api.MapGet("/max-end", (DateOnly tradeDate, ForwardV2TenorCalculator calc) =>
    Results.Ok(new { tradeDate, maxEndDate = calc.GetMaxEndDate(tradeDate) }))
.WithName("GetMaxEnd")
.WithSummary("วันสิ้นสุดสัญญาสูงสุด")
.WithDescription("วันสิ้นสุดสัญญาสูงสุด = Spot value date + 6 เดือน");

// ตาราง tenor 1..6: วันครบกำหนด + ช่วงวันสิ้นสุดที่เลือกได้ (ใช้ทำ calendar UI)
api.MapGet("/tenors", (DateOnly tradeDate, string ccy, ForwardV2TenorCalculator calc) =>
{
    var si = calc.GetSpotInfo(tradeDate);
    var tenors = Enumerable.Range(1, ForwardV2TenorCalculator.MaxTenorMonths).Select(m =>
    {
        var range = calc.GetTenorRange(tradeDate, m, ccy);
        return new
        {
            tenorMonths = m,
            maturity = calc.GetTenorMaturity(tradeDate, m, ccy),
            selectableFrom = range.WinLo,
            selectableTo = range.WinHi,
        };
    });
    return Results.Ok(new
    {
        tradeDate, ccy,
        spotValueDate = si.SpotValueDate,
        isEndOfMonth = si.IsEndOfMonth,
        maxEndDate = calc.GetMaxEndDate(tradeDate),
        tenors,
    });
})
.WithName("GetTenors")
.WithSummary("ตาราง Tenor 1–6")
.WithDescription("คืนวันครบกำหนดของ tenor 1..6 เดือน + ช่วงวันสิ้นสุดที่เลือกได้ (ใช้สร้าง calendar UI)");

// ตรวจว่าวันสิ้นสุดที่เลือก valid ไหม
api.MapGet("/validate-end", (DateOnly tradeDate, int tenor, string ccy, DateOnly endDate,
    DateOnly? creditLineEnd, ForwardV2TenorCalculator calc) =>
{
    var range = calc.GetTenorRange(tradeDate, tenor, ccy);
    var valid = calc.IsEndDateValid(tradeDate, tenor, ccy, endDate, creditLineEnd);
    return Results.Ok(new
    {
        tradeDate, tenor, ccy, endDate, creditLineEnd,
        isValid = valid,
        selectableFrom = range.WinLo,
        selectableTo = range.WinHi,
    });
})
.WithName("ValidateEnd")
.WithSummary("ตรวจสอบวันสิ้นสุดสัญญา")
.WithDescription("ตรวจว่าวันสิ้นสุดที่เลือกอยู่ในช่วง tenor + เป็นวันทำการ + ไม่เกินวันสิ้นสุดวงเงิน");

// ตาราง schedule รายเดือน + (option) rate รายวัน
api.MapGet("/schedule", (DateOnly tradeDate, DateOnly endDate, string ccy,
    string? side, bool? includeDaily, ForwardV2TenorCalculator calc) =>
{
    var sideVal = ParseSide(side);
    var withDaily = includeDaily == true;
    var sched = calc.BuildSchedule(tradeDate, endDate, ccy, sideVal);

    var periods = sched.Periods.Select(p => new
    {
        month = p.Month,
        start = p.Start,
        end = p.End,
        days = p.Days,
        fullPeriodDays = p.FullPeriodDays,
        swapPoint = p.SwapPoint,
        forwardRate = p.ForwardRate,
        isPartial = p.IsPartial,
        daily = withDaily
            ? calc.BuildDailyProrate(p, sched.SpotRate)
                  // ปัดเศษเพื่อการแสดงผล (JPY 6 ตำแหน่ง, สกุลอื่น 4) — ตรงกับ fmtR ในหน้าเว็บ
                  .Select(d => new { d.Seq, d.Date, Rate = Math.Round(d.Rate, ccy == "JPY" ? 6 : 4), d.DayNo, d.TotalDays })
            : null,
    });

    return Results.Ok(new
    {
        tradeDate, endDate, ccy, side = sideVal.ToString(),
        spotValueDate = sched.SpotValueDate,
        isEndOfMonth = sched.IsEndOfMonth,
        spotRate = sched.SpotRate,
        contractMonths = sched.ContractMonths,
        periods,
    });
})
.WithName("GetSchedule")
.WithSummary("ตาราง Schedule รายเดือน")
.WithDescription("ตาราง tenor รายเดือน + เฉลี่ย swap point เมื่อจองไม่เต็มงวด · includeDaily=true เพื่อแนบ rate รายวัน (prorate)");

app.Run();
