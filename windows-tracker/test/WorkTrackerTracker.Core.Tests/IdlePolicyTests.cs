using WorkTrackerTracker.Core;

namespace WorkTrackerTracker.Core.Tests;

public sealed class IdlePolicyTests
{
    [Fact]
    public void RecentInput_IsTreatedAsActive()
    {
        Assert.True(IdlePolicy.ShouldRecordActivity(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void InputExactlyAtPollInterval_IsNotActive()
    {
        // Boundary: input right at the poll interval is not "during" this
        // poll window (mirrors the session calculator's "gap exactly equal
        // to threshold does not split" convention of using strict inequality).
        Assert.False(IdlePolicy.ShouldRecordActivity(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void NoRecentInput_IsNotActive()
    {
        Assert.False(IdlePolicy.ShouldRecordActivity(TimeSpan.FromSeconds(300), TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void ZeroSecondsSinceInput_IsActive()
    {
        Assert.True(IdlePolicy.ShouldRecordActivity(TimeSpan.Zero, TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void DefaultResumeConfirmationWindow_Is60Seconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(60), IdlePolicy.DefaultResumeConfirmationWindow);
    }

    [Fact]
    public void EffectiveResumeConfirmationWindow_KeepsDefaultWhenPollIntervalIsSmall()
    {
        Assert.Equal(TimeSpan.FromSeconds(60), IdlePolicy.EffectiveResumeConfirmationWindow(TimeSpan.FromSeconds(15)));
        Assert.Equal(TimeSpan.FromSeconds(60), IdlePolicy.EffectiveResumeConfirmationWindow(TimeSpan.FromSeconds(30)));
    }

    [Fact]
    public void EffectiveResumeConfirmationWindow_WidensToDoubleThePollIntervalOnceThatExceedsTheDefault()
    {
        Assert.Equal(TimeSpan.FromSeconds(90), IdlePolicy.EffectiveResumeConfirmationWindow(TimeSpan.FromSeconds(45)));
        Assert.Equal(TimeSpan.FromMinutes(4), IdlePolicy.EffectiveResumeConfirmationWindow(TimeSpan.FromMinutes(2)));
    }
}
