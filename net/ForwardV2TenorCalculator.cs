using System;
using System.Collections.Generic;
using System.Linq;

namespace Exim.Fx.Forward
{
    /// <summary>
    /// พอร์ต logic การคำนวณ Tenor แต่ละเดือนของหน้าจอ "Forward v2" (tab sim)
    /// จากไฟล์ต้นฉบับ exim_forward_contract.html (ฟังก์ชัน fwd2*).
    ///
    /// สรุปหลักการ:
    ///   1) วันหยุด  = วันหยุดไทย (ใช้ทุกสกุล) ∪ วันหยุดเฉพาะสกุลเงิน
    ///   2) Spot value date = T+2 วันทำการไทย  (ข้อ 3: spot ดูเฉพาะวันหยุดไทย)
    ///   3) EOM      = ถ้า spot value date เป็นวันทำการสุดท้ายของเดือน → ใช้ End-Of-Month convention
    ///   4) Tenor maturity = spotVal + m เดือน (EOM-aware) แล้วปรับด้วย Modified Following
    ///   5) Tenor range   = (จุดครบ tenor ก่อนหน้า, จุดครบ tenor m]  cap ที่ spotVal + 6 เดือน
    ///   6) Schedule รายเดือน + เฉลี่ย Swap point เมื่อจองไม่เต็มงวด (prorate ตามจำนวนวัน)
    ///
    /// ใช้ DateOnly (.NET 6+) เพื่อสื่อว่าเป็น logic ระดับ "วัน" ล้วน ๆ ไม่มีเวลา/timezone.
    /// </summary>
    public sealed class ForwardV2TenorCalculator
    {
        /// <summary>ทิศทางการทำรายการ — sell แสดง fwd point เป็นค่าบวก (ข้อ 2.3)</summary>
        public enum Side { Buy, Sell }

        // จำนวน tenor สูงสุดที่รองรับ (master = 1..6 เดือน)
        public const int MaxTenorMonths = 6;

        private readonly ForwardV2MarketData _market;

        public ForwardV2TenorCalculator(ForwardV2MarketData market)
        {
            _market = market ?? throw new ArgumentNullException(nameof(market));
        }

        // ============================================================================
        //  วันหยุด / วันทำการ  (fwd2IsHol / fwd2IsBiz / fwd2NextBiz / ...)
        // ============================================================================

        /// <summary>true = เป็นวันหยุดของสกุล ccy (วันหยุดไทย ∪ วันหยุดเฉพาะสกุล)</summary>
        public bool IsHoliday(DateOnly d, string ccy) => _market.IsHoliday(d, ccy);

        /// <summary>true = เป็นวันทำการของสกุล ccy (ไม่ใช่ ส/อา และไม่ใช่วันหยุด)</summary>
        public bool IsBusinessDay(DateOnly d, string ccy) => !IsWeekend(d) && !IsHoliday(d, ccy);

        public DateOnly NextBusinessDay(DateOnly d, string ccy)
        {
            var x = d.AddDays(1);
            while (!IsBusinessDay(x, ccy)) x = x.AddDays(1);
            return x;
        }

        public DateOnly PrevBusinessDay(DateOnly d, string ccy)
        {
            var x = d.AddDays(-1);
            while (!IsBusinessDay(x, ccy)) x = x.AddDays(-1);
            return x;
        }

        /// <summary>Following: ถ้าไม่ใช่วันทำการ → เลื่อนไปวันทำการถัดไป (fwd2AdjBiz)</summary>
        public DateOnly AdjustFollowing(DateOnly d, string ccy)
            => IsBusinessDay(d, ccy) ? d : NextBusinessDay(d, ccy);

        /// <summary>
        /// Modified Following (fwd2AdjModFol): เลื่อนไปวันทำการถัดไป
        /// แต่ถ้าเลื่อนแล้วข้ามไปเดือนอื่น → ถอยกลับมาเป็นวันทำการก่อนหน้าแทน
        /// </summary>
        public DateOnly AdjustModifiedFollowing(DateOnly d, string ccy)
        {
            if (IsBusinessDay(d, ccy)) return d;
            var nb = NextBusinessDay(d, ccy);
            return nb.Month != d.Month ? PrevBusinessDay(d, ccy) : nb;
        }

        /// <summary>บวก n วันทำการ (fwd2AddBizDays)</summary>
        public DateOnly AddBusinessDays(DateOnly d, int n, string ccy)
        {
            var x = d;
            var c = 0;
            while (c < n)
            {
                x = x.AddDays(1);
                if (IsBusinessDay(x, ccy)) c++;
            }
            return x;
        }

        // --- Thai-only variants (spot ดูเฉพาะวันหยุดไทย — ข้อ 3) ---

        public bool IsBusinessDayTh(DateOnly d) => !IsWeekend(d) && !_market.IsThaiHoliday(d);

        public DateOnly NextBusinessDayTh(DateOnly d)
        {
            var x = d.AddDays(1);
            while (!IsBusinessDayTh(x)) x = x.AddDays(1);
            return x;
        }

        public DateOnly AdjustFollowingTh(DateOnly d) => IsBusinessDayTh(d) ? d : NextBusinessDayTh(d);

        public DateOnly AddBusinessDaysTh(DateOnly d, int n)
        {
            var x = d;
            var c = 0;
            while (c < n)
            {
                x = x.AddDays(1);
                if (IsBusinessDayTh(x)) c++;
            }
            return x;
        }

        // ============================================================================
        //  Spot value date + EOM  (fwd2SpotInfo)
        // ============================================================================

        /// <summary>
        /// Spot value date (T+2 วันทำการไทย) + flag ว่าเป็นวันทำการสุดท้ายของเดือนหรือไม่ (EOM).
        /// tradeDate = วันทำรายการจอง.
        /// </summary>
        public SpotInfo GetSpotInfo(DateOnly tradeDate)
        {
            var spotVal = AddBusinessDaysTh(AdjustFollowingTh(tradeDate), 2);
            // ถ้าวันทำการไทยถัดไปข้ามเดือน → spotVal เป็นวันทำการสุดท้ายของเดือน = EOM
            var isEom = NextBusinessDayTh(spotVal).Month != spotVal.Month;
            return new SpotInfo(spotVal, isEom);
        }

        // ============================================================================
        //  Tenor maturity / range / max end  (fwd2TenorMaturity / fwd2TenorRange / fwd2MaxEnd)
        // ============================================================================

        /// <summary>
        /// วันครบกำหนดของ tenor m (default): spotVal + m เดือน (EOM-aware) แล้ว Modified Following.
        /// </summary>
        public DateOnly GetTenorMaturity(DateOnly tradeDate, int tenorMonths, string ccy)
        {
            var si = GetSpotInfo(tradeDate);
            var raw = si.IsEndOfMonth
                ? EndOfMonth(si.SpotValueDate.AddMonths(tenorMonths))   // ยึดวันสุดท้ายของเดือน
                : si.SpotValueDate.AddMonths(tenorMonths);              // วันเดียวกันของเดือนถัดไป (clamp อัตโนมัติ)
            return AdjustModifiedFollowing(raw, ccy);
        }

        /// <summary>วันสิ้นสุดสัญญาสูงสุด = spotVal + 6 เดือน (fwd2MaxEnd)</summary>
        public DateOnly GetMaxEndDate(DateOnly tradeDate)
            => GetSpotInfo(tradeDate).SpotValueDate.AddMonths(MaxTenorMonths);

        /// <summary>
        /// ช่วงวันสิ้นสุดที่เลือกได้ของ tenor m = (จุดครบ tenor ก่อนหน้า, จุดครบ tenor m]
        /// โดย cap winHi ไม่ให้เกิน spotVal + 6 เดือน.
        /// </summary>
        public TenorRange GetTenorRange(DateOnly tradeDate, int tenorMonths, string ccy)
        {
            var si = GetSpotInfo(tradeDate);
            var prevPoint = tenorMonths > 1
                ? GetTenorMaturity(tradeDate, tenorMonths - 1, ccy)
                : si.SpotValueDate;
            var winLo = prevPoint.AddDays(1);
            var winHi = GetTenorMaturity(tradeDate, tenorMonths, ccy);
            var maxEnd = GetMaxEndDate(tradeDate);
            if (winHi > maxEnd) winHi = maxEnd; // tenor 6 แบบ EOM อาจเกิน 6 เดือน 1 วัน → cap
            return new TenorRange(winLo, winHi);
        }

        /// <summary>วันสิ้นสุดที่เลือกไว้ยัง valid ไหม (อยู่ในช่วง tenor + เป็นวันทำการ + ไม่เกินวงเงิน)</summary>
        public bool IsEndDateValid(DateOnly tradeDate, int tenorMonths, string ccy,
            DateOnly endDate, DateOnly? creditLineEnd = null)
        {
            var r = GetTenorRange(tradeDate, tenorMonths, ccy);
            if (endDate < r.WinLo || endDate > r.WinHi) return false;
            if (!IsBusinessDay(endDate, ccy)) return false;
            if (creditLineEnd.HasValue && endDate > creditLineEnd.Value) return false;
            return true;
        }

        // ============================================================================
        //  Schedule รายเดือน + เฉลี่ย Swap point  (loop ใน renderFwd2Sim)
        // ============================================================================

        /// <summary>
        /// สร้างตาราง tenor รายเดือนของสัญญา forward ตั้งแต่ Spot value date ถึง endDate ที่เลือก.
        /// - แต่ละงวดยาว ~1 เดือน; งวดสุดท้ายจบที่ endDate (อาจไม่เต็มเดือน)
        /// - งวดที่จองไม่เต็ม → เฉลี่ย swap point ตามจำนวนวัน (prorate)
        /// </summary>
        public ForwardV2Schedule BuildSchedule(DateOnly tradeDate, DateOnly endDate, string ccy, Side side)
        {
            var si = GetSpotInfo(tradeDate);
            var spotVal = si.SpotValueDate;
            var adjEnd = AdjustFollowing(endDate, ccy); // วันสิ้นสุดสัญญา = วันทำการตามสกุล

            // จำนวนเดือนของสัญญา ≈ round(จำนวนวัน / 30) แล้ว clamp 0..6  (ตาม logic ต้นฉบับ)
            var totalDays = adjEnd.DayNumber - spotVal.DayNumber;
            var maxMo = Math.Max(0, Math.Min(MaxTenorMonths, (int)Math.Round(totalDays / 30.0, MidpointRounding.AwayFromZero)));

            var spotRate = _market.GetSpotRate(ccy);
            var periods = new List<TenorPeriod>();

            var prevEnd = spotVal;
            for (var m = 1; m <= maxMo; m++)
            {
                var rowStart = prevEnd.AddDays(1);
                var rawMonthEnd = si.IsEndOfMonth
                    ? EndOfMonth(spotVal.AddMonths(m))
                    : spotVal.AddMonths(m);

                var fullEnd = AdjustModifiedFollowing(rawMonthEnd, ccy); // จุดครบกำหนดเต็มงวด
                var rowEnd = (m == maxMo) ? adjEnd : fullEnd;            // งวดสุดท้ายจบที่วันที่เลือกจริง

                // เฉลี่ย Swap point เมื่อจองไม่เต็มงวด:
                //   Swap(เฉลี่ย) = ROUND( ((SwFull − SwPrev) / fullDays) × actualDays + SwPrev , 4 )
                var swPrev = m > 1 ? GetSwapPoint(ccy, m - 1, side) : 0m; // งวดแรก งวดก่อน = spot = 0
                var swFull = GetSwapPoint(ccy, m, side);
                var fullDays = fullEnd.DayNumber - rowStart.DayNumber + 1;   // inclusive
                var actualDays = rowEnd.DayNumber - rowStart.DayNumber + 1;  // inclusive

                decimal sw = fullDays > 0
                    ? JsRound(((swFull - swPrev) / fullDays) * actualDays + swPrev, 4)
                    : swFull;
                var partial = actualDays < fullDays;

                periods.Add(new TenorPeriod(
                    Month: m,
                    Start: rowStart,
                    End: rowEnd,
                    Days: actualDays,
                    FullPeriodDays: fullDays,
                    SwapPoint: sw,
                    ForwardRate: spotRate + sw,
                    IsPartial: partial));

                prevEnd = rowEnd;
            }

            return new ForwardV2Schedule(
                SpotValueDate: spotVal,
                IsEndOfMonth: si.IsEndOfMonth,
                SpotRate: spotRate,
                ContractMonths: maxMo,
                Periods: periods);
        }

        /// <summary>
        /// Rate รายวันของงวด (prorate): Rate = Spot + SwapPoint × (วันที่จากต้นงวด / จำนวนวันรวมของงวด).
        /// วันสุดท้าย (ครบ tenor) = Forward Rate เต็ม.
        /// </summary>
        public IEnumerable<DailyProrateRate> BuildDailyProrate(TenorPeriod period, decimal spotRate)
        {
            var totalDays = period.End.DayNumber - period.Start.DayNumber + 1; // inclusive = term
            var seq = 0;
            for (var d = period.Start; d <= period.End; d = d.AddDays(1))
            {
                seq++;
                var dayNo = d.DayNumber - period.Start.DayNumber + 1; // 1..term
                var rate = spotRate + period.SwapPoint * (totalDays > 0 ? (decimal)dayNo / totalDays : 0m);
                yield return new DailyProrateRate(seq, d, rate, dayNo, totalDays);
            }
        }

        // ============================================================================
        //  Helpers
        // ============================================================================

        /// <summary>fwd point ของ v2: ทิศทางขายแสดงเป็นค่าบวก (fwd2Sw)</summary>
        private decimal GetSwapPoint(string ccy, int tenorMonths, Side side)
        {
            var v = _market.GetSwapPoint(ccy, tenorMonths);
            return side == Side.Sell ? Math.Abs(v) : v;
        }

        private static bool IsWeekend(DateOnly d)
            => d.DayOfWeek == DayOfWeek.Saturday || d.DayOfWeek == DayOfWeek.Sunday;

        private static DateOnly EndOfMonth(DateOnly d)
            => new DateOnly(d.Year, d.Month, DateTime.DaysInMonth(d.Year, d.Month));

        /// <summary>
        /// เลียนแบบ JavaScript Math.round(x * 10^dp) / 10^dp — ปัดครึ่งขึ้น (ไปทาง +∞).
        /// ต่างจาก Math.Round ของ .NET ตรงกรณีค่าลบลงท้าย .5 (เช่น -0.5 → 0, ไม่ใช่ -1).
        /// </summary>
        private static decimal JsRound(decimal value, int decimals)
        {
            var factor = (decimal)Math.Pow(10, decimals);
            return Math.Floor(value * factor + 0.5m) / factor;
        }
    }

    // ================================================================================
    //  Market data (spot / swap points / holidays) — implement ตามแหล่งข้อมูลจริง
    // ================================================================================

    /// <summary>
    /// แหล่งข้อมูลตลาดที่ calculator ต้องใช้ (spot rate, swap point รายเดือน, วันหยุด).
    /// ในระบบจริงควร inject จาก DB/service; ตัวอย่าง in-memory ดู <see cref="InMemoryForwardV2MarketData"/>.
    /// </summary>
    public abstract class ForwardV2MarketData
    {
        /// <summary>Spot rate ปัจจุบันของสกุล ccy</summary>
        public abstract decimal GetSpotRate(string ccy);

        /// <summary>Swap point (fwd point) ของ tenor m เดือน (ค่า master ตามเครื่องหมายจริง)</summary>
        public abstract decimal GetSwapPoint(string ccy, int tenorMonths);

        /// <summary>วันหยุดไทย (ใช้กับทุกสกุล)</summary>
        public abstract bool IsThaiHoliday(DateOnly d);

        /// <summary>วันหยุดเฉพาะสกุล ccy</summary>
        public abstract bool IsCurrencyHoliday(DateOnly d, string ccy);

        /// <summary>วันหยุดที่ใช้กับสกุล ccy = ไทย ∪ เฉพาะสกุล</summary>
        public bool IsHoliday(DateOnly d, string ccy) => IsThaiHoliday(d) || IsCurrencyHoliday(d, ccy);
    }

    /// <summary>ตัวอย่าง market data แบบ in-memory (ค่า mock จากไฟล์ต้นฉบับ)</summary>
    public sealed class InMemoryForwardV2MarketData : ForwardV2MarketData
    {
        private readonly Dictionary<string, decimal> _spot;
        private readonly Dictionary<string, decimal[]> _swap; // index 0 = tenor 1 เดือน
        private readonly HashSet<DateOnly> _thaiHolidays;
        private readonly Dictionary<string, HashSet<DateOnly>> _ccyHolidays;

        public InMemoryForwardV2MarketData(
            Dictionary<string, decimal> spot,
            Dictionary<string, decimal[]> swapPointsByTenor,
            IEnumerable<DateOnly> thaiHolidays,
            Dictionary<string, HashSet<DateOnly>> currencyHolidays)
        {
            _spot = spot;
            _swap = swapPointsByTenor;
            _thaiHolidays = new HashSet<DateOnly>(thaiHolidays);
            _ccyHolidays = currencyHolidays;
        }

        public override decimal GetSpotRate(string ccy)
            => _spot.TryGetValue(ccy, out var v) ? v : 0m;

        public override decimal GetSwapPoint(string ccy, int tenorMonths)
        {
            if (_swap.TryGetValue(ccy, out var arr) && tenorMonths >= 1 && tenorMonths <= arr.Length)
                return arr[tenorMonths - 1];
            return 0m;
        }

        public override bool IsThaiHoliday(DateOnly d) => _thaiHolidays.Contains(d);

        public override bool IsCurrencyHoliday(DateOnly d, string ccy)
            => _ccyHolidays.TryGetValue(ccy, out var set) && set.Contains(d);
    }

    // ================================================================================
    //  Result records
    // ================================================================================

    /// <summary>Spot value date + flag EOM</summary>
    public readonly record struct SpotInfo(DateOnly SpotValueDate, bool IsEndOfMonth);

    /// <summary>ช่วงวันสิ้นสุดที่เลือกได้ของ tenor: (WinLo, WinHi]</summary>
    public readonly record struct TenorRange(DateOnly WinLo, DateOnly WinHi);

    /// <summary>งวด tenor 1 เดือนในตาราง</summary>
    public readonly record struct TenorPeriod(
        int Month,
        DateOnly Start,
        DateOnly End,
        int Days,
        int FullPeriodDays,
        decimal SwapPoint,
        decimal ForwardRate,
        bool IsPartial);

    /// <summary>ผลลัพธ์ทั้ง schedule ของสัญญา</summary>
    public sealed record ForwardV2Schedule(
        DateOnly SpotValueDate,
        bool IsEndOfMonth,
        decimal SpotRate,
        int ContractMonths,
        IReadOnlyList<TenorPeriod> Periods);

    /// <summary>Rate รายวันของงวด (prorate)</summary>
    public readonly record struct DailyProrateRate(int Seq, DateOnly Date, decimal Rate, int DayNo, int TotalDays);
}
